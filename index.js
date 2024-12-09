const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs-extra');  // Use fs-extra for cross-platform directory removal
const path = require('path');
const Docker = require('dockerode');
const yaml = require('js-yaml');

// Initialize Express
const app = express();
const port = 3000;

app.use(express.json());

// Initialize Dockerode (connecting to Docker locally)
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.post('/create-network', (req, res) => {
    try {
        const participants = req.body; // New structure
        const nodeTypes = [];
        const roles = [];
        const participantAddresses = [];
        const NODES_NB = Object.keys(participants).length;

        const parentPath = path.dirname(__filename);

        // Validate incoming JSON structure
        if (!participants || typeof participants !== 'object') {
            return res.status(400).json({ message: 'Invalid data format. Expected an object.' });
        }

        console.log("Setting up network...");

        const quorumPath = path.join(parentPath, 'quorum');
        const qbftNetworkPath = path.join(parentPath, 'QBFT-Network');

        // Clean up the directory if it exists
        fs.removeSync(qbftNetworkPath);
        fs.mkdirSync(qbftNetworkPath);

        // Generate genesis file with 1 member
        const genesisCmd = `yes | npx quorum-genesis-tool --consensus qbft --chainID 1337 --blockperiod 1 --emptyBlockPeriod 1 --requestTimeout 10 --epochLength 30000 --difficulty 1 --gasLimit '0xFFFFFF' --coinbase '0x0000000000000000000000000000000000000000' --validators ${NODES_NB} --members 1 --bootnodes 0 --outputPath '${path.join(qbftNetworkPath, 'artifacts')}'`;

        const outputDir = execSync(genesisCmd).toString().split('\n').find(line => line.includes("artifacts/")).split(' ')[3];

        // Move files to the artifacts directory
        const artifactsPath = path.join(qbftNetworkPath, 'artifacts');

        fs.readdirSync(outputDir).forEach(file => {
            const srcPath = path.join(outputDir, file);
            const destPath = path.join(artifactsPath, file);
            fs.moveSync(srcPath, destPath, { overwrite: true });
        });

        // Remove the now-empty dynamic output directory
        fs.removeSync(outputDir);

        const goQuorumDir = path.join(qbftNetworkPath, 'artifacts', 'goQuorum');

        // Modify static-nodes.json using full paths
        const staticNodesPath = path.join(goQuorumDir, 'static-nodes.json');
        let staticNodes = fs.readFileSync(staticNodesPath, 'utf8');

        staticNodes = JSON.parse(staticNodes).map((node, index) => {
            const nodeIp = `172.16.239.${10 + index}`;
            const updatedNode = node.replace(/<HOST>/g, nodeIp);
            return updatedNode;
        });

        fs.writeFileSync(staticNodesPath, JSON.stringify(staticNodes, null, 2));

        // Process each participant and extract addresses
        Object.entries(participants).forEach(([role, details], index) => {
            roles.push(role);

            if (details.nodeType) {
                nodeTypes.push(details.nodeType);
            } else {
                return res.status(400).json({ message: `Node type for ${role} is required.` });
            }

            // Construct path to the address file for the current participant
            const addressFilePath = path.join(artifactsPath, `validator${index}`, 'accountAddress');

            // Check if the address file exists and is a file
            if (fs.existsSync(addressFilePath) && fs.statSync(addressFilePath).isFile()) {
                const address = fs.readFileSync(addressFilePath, 'utf8').trim();
                participantAddresses.push(address);
            } else {
                // If the address file is not found, return an error response
                return res.status(400).json({ message: `Address file not found for participant ${role}.` });
            }
        });

        // Create permissioned nodes and configure ports using full paths
        let dockerCompose = {
            version: '3',
            services: {}
        };

        // Add each validator node
        for (let i = 0; i < NODES_NB; i++) {
            const nodeDataPath = path.join(qbftNetworkPath, `Node-${i}`, 'data');
            const keystorePath = path.join(nodeDataPath, 'keystore');

            fs.mkdirSync(nodeDataPath, { recursive: true });
            fs.mkdirSync(keystorePath, { recursive: true });

            fs.copyFileSync(staticNodesPath, path.join(nodeDataPath, 'static-nodes.json'));
            fs.copyFileSync(path.join(goQuorumDir, 'genesis.json'), path.join(nodeDataPath, 'genesis.json'));

            const validatorDir = path.join(artifactsPath, `validator${i}`);
            const nodeKeys = fs.readdirSync(validatorDir).filter(file => file.startsWith('nodekey'));

            nodeKeys.forEach(file => {
                fs.copyFileSync(path.join(validatorDir, file), path.join(nodeDataPath, file));
            });

            const addressFile = path.join(validatorDir, 'address');
            if (fs.existsSync(addressFile) && fs.statSync(addressFile).isFile()) {
                fs.copyFileSync(addressFile, path.join(nodeDataPath, 'address'));
            }

            const accounts = fs.readdirSync(validatorDir).filter(file => file.startsWith('account'));
            accounts.forEach(file => {
                fs.copyFileSync(path.join(validatorDir, file), path.join(keystorePath, file));
            });

            const http = 8545 + i;

            // Generate start-node.sh

            const currentRole = roles[i];
            const currentDetails = participants[currentRole];

            const nodeType = nodeTypes[i];
            let nodeTypeFlag = '';
            let censorTargetsArray = '';

            if (nodeType === 'censor') {
                // Get the targets from the details
                const targets = currentDetails.censorTargets || [];

                // Map the targets to their corresponding addresses
                censorTargetsArray = JSON.stringify(targets.map(target => {
                    const targetIndex = roles.indexOf(target);
                    return targetIndex !== -1 ? participantAddresses[targetIndex] : null;
                }).filter(address => address !== null)); // Filter out any nulls

                nodeTypeFlag = `--nodetype censor --censored '${censorTargetsArray}'`;
            } else if (nodeType === 'displace') {
                nodeTypeFlag = '--nodetype displace';
            }

            const startNodeScript = `#!/bin/sh
            geth --datadir /data init /data/genesis.json
            
            ACCOUNT_ADDRESS=$(grep -o '"address": *"[^"]*"' ./data/keystore/accountKeystore | grep -o '"[^"]*"$' | sed 's/"//g')
            echo -n "" > /data/keystore/emptyPassword.txt
            
            geth --datadir /data \\
                --networkid 1337 \\
                --nodiscover \\
                --verbosity 5 \\
                --syncmode full \\
                --istanbul.blockperiod 5 \\
                --mine \\
                --miner.threads 1 \\
                --miner.gasprice 0 \\
                --emitcheckpoints \\
                --http --http.addr 0.0.0.0 --http.port 8545 --http.corsdomain "*" --http.vhosts "*" \\
                --ws --ws.addr 0.0.0.0 --ws.port 8546 --ws.origins "*" \\
                --http.api admin,eth,debug,miner,net,txpool,personal,web3,istanbul \\
                --ws.api admin,eth,debug,miner,net,txpool,personal,web3,istanbul \\
                --unlock "$ACCOUNT_ADDRESS" \\
                --allow-insecure-unlock \\
                --password /data/keystore/emptyPassword.txt \\
                --port 30303 \\
                --ipcpath /tmp/geth.ipc \\
                ${nodeTypeFlag}
            `;
            fs.writeFileSync(path.join(qbftNetworkPath, `Node-${i}`, 'data', 'start-node.sh'), startNodeScript);

            // Store role and node type in nodeConfig.json
            const nodeConfig = {
                role: roles[i],
                nodeType: nodeType
            };
            fs.writeFileSync(path.join(nodeDataPath, 'nodeConfig.json'), JSON.stringify(nodeConfig, null, 2));

            dockerCompose.services[`node${i}`] = {
                image: 'your-quorum-image',
                ports: [
                    `30303`,   // Map base port for Quorum
                    `8546`,      // Map WebSocket port
                    `${http}:8545`     // Map HTTP port
                ],
                volumes: [
                    `${nodeDataPath}:/data`,
                ],
                networks: {
                    quorum_network: {
                        ipv4_address: `172.16.239.${10 + i}`
                    }
                },
                entrypoint: [
                    '/bin/sh', '-c', 
                    'chmod +x /data/start-node.sh && /data/start-node.sh'
                ]
            };
        }

        // Setup for member0
        const memberDataPath = path.join(qbftNetworkPath, 'member0', 'data');
        const memberKeystorePath = path.join(memberDataPath, 'keystore');

        fs.mkdirSync(memberDataPath, { recursive: true });
        fs.mkdirSync(memberKeystorePath, { recursive: true });

        // Copy genesis and static-nodes.json
        fs.copyFileSync(staticNodesPath, path.join(memberDataPath, 'static-nodes.json'));
        fs.copyFileSync(path.join(goQuorumDir, 'genesis.json'), path.join(memberDataPath, 'genesis.json'));

        // Copy member node keys
        const memberDir = path.join(artifactsPath, 'member0');
        fs.readdirSync(memberDir).forEach(file => {
            fs.copyFileSync(path.join(memberDir, file), path.join(memberDataPath, file.startsWith('account') ? 'keystore' : '', file));
        });

        // Create start-node.sh for member0 with updated HTTP and WS ports to avoid conflicts
        const startMemberScript = `#!/bin/sh
        geth --datadir /data init /data/genesis.json
        
        ACCOUNT_ADDRESS=$(grep -o '"address": *"[^"]*"' /data/keystore/accountKeystore | grep -o '"[^"]*"$' | sed 's/"//g')
        echo -n "" > /data/keystore/emptyPassword.txt
        
        # Start the Geth node for member0
        geth --datadir /data \\
            --networkid 1337 \\
            --nodiscover \\
            --verbosity 5 \\
            --syncmode full \\
            --emitcheckpoints \\
            --http --http.addr 0.0.0.0 --http.port 8550 --http.corsdomain "*" --http.vhosts "*" \\
            --ws --ws.addr 0.0.0.0 --ws.port 8551 --ws.origins "*" \\
            --http.api admin,eth,debug,net,txpool,personal,web3,istanbul \\
            --ws.api admin,eth,debug,net,txpool,personal,web3,istanbul \\
            --unlock "$ACCOUNT_ADDRESS" \\
            --allow-insecure-unlock \\
            --password /data/keystore/emptyPassword.txt \\
            --port 30305 \\
            --ipcpath /tmp/geth.ipc
        `;

        fs.writeFileSync(path.join(memberDataPath, 'start-node.sh'), startMemberScript);

        // Add member0 to Docker compose with updated ports
        dockerCompose.services['member0'] = {
            image: 'your-quorum-image',
            ports: [
                `30305:30305`,  // Node communication port
                `8550:8550`,    // HTTP port mapped externally for API access
                `8551:8551`     // WebSocket port mapped externally
            ],
            volumes: [
                `${memberDataPath}:/data`
            ],
            networks: {
                quorum_network: {
                    ipv4_address: '172.16.239.20'
                }
            },
            entrypoint: [
                '/bin/sh', '-c', 
                'chmod +x /data/start-node.sh && /data/start-node.sh'
            ]
        };


        // Configure networks in docker-compose.yml
        dockerCompose.networks = {
            quorum_network: {
                driver: 'bridge',
                ipam: {
                    config: [{ subnet: '172.16.239.0/24' }]
                }
            }
        };

        const composeFilePath = path.join(qbftNetworkPath, 'docker-compose.yml');
        fs.writeFileSync(composeFilePath, yaml.dump(dockerCompose));

        console.log("Network created successfully.");
        res.status(201).json({ message: 'Network created successfully.' });

    } catch (err) {
        console.error('Error:', err.message);
        res.status(500).json({ message: 'An error occurred while creating the network.' });
    }
});



app.post('/start-network', (req, res) => {
    try {
        const parentPath = path.dirname(__filename);
        const qbftNetworkPath = path.join(parentPath, 'QBFT-Network');
        const dockerComposeFilePath = path.join(qbftNetworkPath, 'docker-compose.yml');

        // Check if docker-compose.yml exists
        if (!fs.existsSync(dockerComposeFilePath)) {
            return res.status(404).json({ message: 'Docker Compose file not found.' });
        }

        try {
            // Start the Docker Compose process synchronously
            const result = execSync(`docker-compose -f ${dockerComposeFilePath} up -d`, { cwd: qbftNetworkPath });

            res.json({ message: 'Network started successfully.' });
        } catch (error) {
            console.error(`Error starting Docker Compose: ${error.message}`);
            return res.status(500).json({ message: 'Failed to start the network.', error: error.message });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'An error occurred while starting the network.', error: error.message });
    }
});

app.post('/stop-network', (req, res) => {
    try {
        const parentPath = path.dirname(__filename);
        const qbftNetworkPath = path.join(parentPath, 'QBFT-Network');
        const dockerComposeFilePath = path.join(qbftNetworkPath, 'docker-compose.yml');

        // Check if docker-compose.yml exists
        if (!fs.existsSync(dockerComposeFilePath)) {
            return res.status(404).json({ message: 'Docker Compose file not found.' });
        }

        try {
            // Stop the Docker Compose network
            const stopResult = execSync(`docker-compose -f ${dockerComposeFilePath} down`, { cwd: qbftNetworkPath });

            console.log(`Docker Compose stdout (stopped): ${stopResult.toString()}`);
            res.json({ message: 'Network stopped and removed successfully.' });
        } catch (error) {
            console.error(`Error stopping Docker Compose: ${error.message}`);
            return res.status(500).json({ message: 'Failed to stop and remove the network.', error: error.message });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'An error occurred while stopping the network.', error: error.message });
    }
});

// Endpoint to accept participants and save to a JSON file
app.post('/start-process-instances', (req, res) => {
    const parentPath = path.dirname(__filename);
    const qbftNetworkPath = path.join(parentPath, 'QBFT-Network');

    const processInstances = req.body; // Array of arrays with participants

    if (!Array.isArray(processInstances)) {
        return res.status(400).json({ message: 'Invalid data format. Expected an array of arrays.' });
    }

    // Validate that each array has exactly 3 participants
    const isValid = processInstances.every(instance => Array.isArray(instance) && instance.length === 3);

    if (!isValid) {
        return res.status(400).json({ message: 'Each process instance must contain exactly 3 participants.' });
    }

    const data = { processInstances };

    const filePath = path.join(qbftNetworkPath, 'processInstances.json');

    // Write the data to a JSON file
    fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
        if (err) {
            return res.status(500).json({ message: 'Failed to save data' });
        }
        res.status(200).json({ message: 'Data saved successfully' });
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
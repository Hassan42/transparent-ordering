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
        const NODES_NB = req.body.nodes || 3;
        const parentPath = path.dirname(__filename);

        console.log("Setting up network...");

        const quorumPath = path.join(parentPath, 'quorum');
        const qbftNetworkPath = path.join(parentPath, 'QBFT-Network');

        // Clean up the directory if it exists
        fs.removeSync(qbftNetworkPath);
        fs.mkdirSync(qbftNetworkPath);

        // Generate genesis file in the new directory
        const genesisCmd = `yes | npx quorum-genesis-tool --consensus qbft --chainID 1337 --blockperiod 1 --emptyBlockPeriod 1 --requestTimeout 10 --epochLength 30000 --difficulty 1 --gasLimit '0xFFFFFF' --coinbase '0x0000000000000000000000000000000000000000' --validators ${NODES_NB} --members 0 --bootnodes 0 --outputPath '${path.join(qbftNetworkPath, 'artifacts')}'`;

        const outputDir = execSync(genesisCmd).toString().split('\n').find(line => line.includes("artifacts/")).split(' ')[3];

        // Move files to the artifacts directory
        const artifactsPath = path.join(qbftNetworkPath, 'artifacts');

        // Move all files from the dynamically generated output directory to 'artifacts'
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

        // Parse the JSON and update nodes with unique IPs and ports
        staticNodes = JSON.parse(staticNodes).map((node, index) => {
            const nodeIp = `172.16.239.${10 + index}`; // Calculate the correct IP address for each node
            const updatedNode = node
                .replace(/<HOST>/g, nodeIp)                // Replace <HOST> with the current node's IP
                // .replace(/:30303/, `:${NODE_PORT + index}`); // Update the port number
            return updatedNode;
        });

        // Write the updated array back to the file as a string
        fs.writeFileSync(staticNodesPath, JSON.stringify(staticNodes, null, 2));

        // Create permissioned nodes and configure ports using full paths
        let dockerCompose = {
            version: '3',
            services: {}
        };

        for (let i = 0; i < NODES_NB; i++) {
            const nodeDataPath = path.join(qbftNetworkPath, `Node-${i}`, 'data');
            const keystorePath = path.join(nodeDataPath, 'keystore');

            // Create directories for node data and keystore
            fs.mkdirSync(nodeDataPath, { recursive: true });
            fs.mkdirSync(keystorePath, { recursive: true });

            // Copy static-nodes.json and genesis.json to each node's data directory
            fs.copyFileSync(staticNodesPath, path.join(nodeDataPath, 'static-nodes.json'));
            fs.copyFileSync(path.join(goQuorumDir, 'genesis.json'), path.join(nodeDataPath, 'genesis.json'));

            // Copy nodekey and address files from each validator directory
            const validatorDir = path.join(artifactsPath, `validator${i}`);
            const nodeKeys = fs.readdirSync(validatorDir).filter(file => file.startsWith('nodekey'));

            // Copy all nodekey files
            nodeKeys.forEach(file => {
                fs.copyFileSync(path.join(validatorDir, file), path.join(nodeDataPath, file));
            });

            // Copy address file to node
            const addressFile = path.join(validatorDir, 'address');
            if (fs.existsSync(addressFile) && fs.statSync(addressFile).isFile()) {
                fs.copyFileSync(addressFile, path.join(nodeDataPath, 'address'));
            } else {
                console.error(`Address file does not exist or is not a file: ${addressFile}`);
            }

            // Copy account keys to the keystore directory for each node
            const accounts = fs.readdirSync(validatorDir).filter(file => file.startsWith('account'));
            accounts.forEach(file => {
                fs.copyFileSync(path.join(validatorDir, file), path.join(keystorePath, file));
            });


            // Define the ports for each node
            const port = 30300 + i;  // Base port for each node
            const ws = 32000 + i;    // WebSocket port for each node
            const http = 22000 + i;  // HTTP port for each node

            // Define the Docker service for each node
            dockerCompose.services[`node${i}`] = {
                image: 'your-quorum-image', // Updated to specified image name
                ports: [
                    `30303`,   // Map base port for Quorum
                    `8546`,      // Map WebSocket port
                    `8545`     // Map HTTP port
                ],
                volumes: [
                    `${nodeDataPath}:/data`, // Mount the node data directory
                ],
                networks: {
                    quorum_network: {
                        ipv4_address: `172.16.239.${10 + i}` // Set static IP for the node
                    }
                }
            };
        }

        // Add network configuration
        dockerCompose.networks = {
            quorum_network: {
                driver: 'bridge',
                ipam: {
                    config: [{
                        subnet: '172.16.239.0/24', // Define the subnet for the network
                    }]
                }
            }
        };

        // Write the Docker Compose file
        const composeFilePath = path.join(qbftNetworkPath, 'docker-compose.yml');
        fs.writeFileSync(composeFilePath, yaml.dump(dockerCompose));

        // Copy static-nodes.json to permissioned-nodes.json using full paths
        const permissionedNodesPath = path.join(goQuorumDir, 'permissioned-nodes.json');
        fs.copyFileSync(staticNodesPath, permissionedNodesPath);

        // Return success response
        res.json({ message: `Network with ${NODES_NB} nodes created successfully.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'An error occurred while setting up the network.', error: error.message });
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

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
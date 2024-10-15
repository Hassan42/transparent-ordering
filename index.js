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

        // Create Prometheus configuration file
        const prometheusConfig = `
        global:
          scrape_interval:     15s # Set the scrape interval to every 15 seconds. Default is every 1 minute.
          evaluation_interval: 15s # Evaluate rules every 15 seconds. The default is every 1 minute.
        
        # Alertmanager configuration
        alerting:
        #  alertmanagers:
        #  - static_configs:
        #    - targets:
        # - alertmanager:9093
        
        # Load rules once and periodically evaluate them according to the global 'evaluation_interval'.
        rule_files:
        # - "first_rules.yml"
        # - "second_rules.yml"
        
        scrape_configs:
        ${Array(NODES_NB).fill(0).map((_, i) => `
            - job_name: node${i + 1}
              scrape_interval: 15s
              scrape_timeout: 10s
              scheme: http
              static_configs:
                - targets: [ 'localhost:${22000 + i}' ]`).join('')}
        `;
        fs.writeFileSync(path.join(qbftNetworkPath, 'prometheus.yml'), prometheusConfig);

        // Create permissioned nodes and configure ports using full paths
        let dockerCompose = {
            version: '3',
            services: {}
        };

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

            const port = 30300 + i;
            const ws = 32000 + i;
            const http = 22000 + i;

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
                }
            };
        }

        // Add Prometheus and Grafana to docker-compose.yml
        dockerCompose.services['prometheus'] = {
            image: 'prom/prometheus',
            ports: ['9090:9090'],
            volumes: [
                './prometheus.yml:/etc/prometheus/prometheus.yml'
            ],
            networks: {
                quorum_network: {
                    ipv4_address: '172.16.239.20'
                }
            }
        };

        dockerCompose.services['grafana'] = {
            image: 'grafana/grafana',
            ports: ['3000:3000'],
            volumes: [
                './grafana:/var/lib/grafana'
            ],
            depends_on: ['prometheus'],
            networks: {
                quorum_network: {
                    ipv4_address: '172.16.239.21'
                }
            }
        };

        dockerCompose.networks = {
            quorum_network: {
                driver: 'bridge',
                ipam: {
                    config: [{
                        subnet: '172.16.239.0/24',
                    }]
                }
            }
        };

        const composeFilePath = path.join(qbftNetworkPath, 'docker-compose.yml');
        fs.writeFileSync(composeFilePath, yaml.dump(dockerCompose));

        const permissionedNodesPath = path.join(goQuorumDir, 'permissioned-nodes.json');
        fs.copyFileSync(staticNodesPath, permissionedNodesPath);

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
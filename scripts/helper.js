const fs = require('fs');
const path = require('path');

// Define the base directory for your nodes
const baseDir = path.join(__dirname, '../QBFT-Network');



// Function to dynamically get node folders from the QBFT-Network directory
function getNodes() {
    try {
        // Read the contents of the base directory and filter out directories that start with "Node"
        return fs.readdirSync(baseDir).filter(file => {
            const fullPath = path.join(baseDir, file);
            return fs.statSync(fullPath).isDirectory() && file.startsWith('Node-');
        });
    } catch (error) {
        console.error('Error reading nodes:', error);
        return [];
    }
}

// Function to read the public and private keys along with roles for each node
async function getParticipants() {
    let participants = {};
    const nodes = getNodes(); // Get the list of nodes dynamically

    for (const node of nodes) {
        const nodeDir = path.join(baseDir, node, 'data');

        try {
            // Read node configuration from nodeConfig.json
            const configPath = path.join(nodeDir, 'nodeConfig.json');
            let config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { role: 'unknown', nodeType: 'unknown' };

            // Read public key
            const publicKeyPath = path.join(nodeDir, 'keystore', 'accountAddress');
            const publicKey = fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf8').trim() : 'unknown';

            // Read private key
            const privateKeyPath = path.join(nodeDir, 'keystore', 'accountPrivateKey');
            const privateKey = fs.existsSync(privateKeyPath) ? fs.readFileSync(privateKeyPath, 'utf8').trim() : 'unknown';

            // Store role, type, public, and private keys in the object
            participants[config.role] = {
                node,
                nodeType: config.nodeType,
                publicKey,
                privateKey
            };
        } catch (error) {
            console.error(`Error reading data for ${node}:`, error);
        }
    }

    return participants;
}

module.exports = { getParticipants };
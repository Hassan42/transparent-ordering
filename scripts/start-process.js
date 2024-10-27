const hre = require("hardhat");
const { ethers } = require("hardhat");
const { getParticipants } = require('./helper');
const fs = require('fs');
const path = require('path');

async function main() {
    
    const epochs = 50;
    // Retrieve participants and validate against process instances
    // const participants = await getParticipantsAndValidate();
    // if (!participants) return;

    // // Deploy contracts
    // const { processContract, orderingContract } = await deployContracts();

    // // Create process instances and log instance details
    // const instancesDetails = await createProcessInstances(processContract, participants);
    // console.log('Created instances:', instancesDetails);

    // // Generate a random log with the desired number of entries
    // const randomLog = generateRandomLog(instancesDetails.length, epochs); // Generate 500 entries
    // console.log('Generated Random Log:', randomLog);

    const participants = await getParticipants();

    console.log(participants)

    let customer1First = 0;
    let customer2First = 0;
    const emptyAddress = "0x0000000000000000000000000000000000000000";

    // Loop to simulate each participant sending a transaction
    for (let i = 0; i < epochs; i++) {
        // Send transactions in parallel
        const [tx1, tx2] = await Promise.all([
            sendTransaction(participants.cusomter1.wallet, emptyAddress),
            sendTransaction(participants.cusomter2.wallet, emptyAddress)
        ]);

        // Wait for both transactions to be mined and get the block number
        const receipt1 = await tx1.wait();
        const receipt2 = await tx2.wait();

        // Check who was first based on transaction index
        if (receipt1.blockNumber === receipt2.blockNumber) {

            const isCustomer1First = receipt1.index < receipt2.index;
            if (isCustomer1First) {
                customer1First++;
            } else {
                customer2First++;
            }
        } else {
            console.log("Transactions mined in different blocks");
        }
    }

    console.log(`Customer1 was first in ${customer1First} blocks`);
    console.log(`Customer2 was first in ${customer2First} blocks`);
}

// Function to send a transaction from a specific wallet
async function sendTransaction(senderWallet, recipientAddress) {
    const tx = {
        to: recipientAddress,
        value: ethers.parseEther("0.01"), // Sending a small amount
        gasLimit: 21000 // Minimum gas limit for simple ETH transfer
    };

    return await senderWallet.sendTransaction(tx);
}




// Retrieve participants and validate against processInstances.json
async function getParticipantsAndValidate() {
    const participants = await getParticipants();
    const processInstancesPath = getProcessInstancesPath();
    if (!fs.existsSync(processInstancesPath)) {
        console.error('processInstances.json not found at:', processInstancesPath);
        return null;
    }

    const processInstancesData = fs.readFileSync(processInstancesPath, 'utf8');
    const processInstances = JSON.parse(processInstancesData).processInstances;

    // Validate roles
    const allRolesMatch = processInstances.every(instance =>
        instance.every(role => {
            if (participants[role]) return true;
            console.log(`Role ${role} not found`);
            return false;
        })
    );

    if (!allRolesMatch) {
        console.error('Mismatch in roles.');
        return null;
    }
    return participants;
}

// Get the file path for process instances
function getProcessInstancesPath() {
    const parentPath = path.dirname(__filename);
    return path.join(parentPath, '..', 'QBFT-Network', 'processInstances.json');
}

// Deploy ProcessContract and OrderingContract
async function deployContracts() {
    const ProcessContract = await ethers.getContractFactory("ProcessContract");
    const processContract = await ProcessContract.deploy();
    console.log(`ProcessContract deployed at: ${processContract.target}`);

    const OrderingContract = await ethers.getContractFactory("OrderingContract");
    const orderingContract = await OrderingContract.deploy(processContract.target);
    console.log(`OrderingContract deployed at: ${orderingContract.target}`);

    return { processContract, orderingContract };
}

// Create process instances on the blockchain and return details
/**
 * Creates new process instances on the blockchain.
 *
 * @param {Object} processContract - The deployed ProcessContract instance.
 * @param {Object} participants - An object containing participant roles and their public keys and wallets.
 * 
 * @returns {Array<Object>} - An array of objects, each representing a process instance, with the following structure:
 *   - instanceID: {number} The ID of the created instance.
 *   - participants: {Array<Object>} An array of participant details for the instance, where each entry has:
 *     - role: {string} The role of the participant in the instance.
 *     - publicKey: {string} The public key of the participant.
 *     - wallet: {string} The wallet address of the participant.
 */
async function createProcessInstances(processContract, participants) {
    const processInstancesPath = getProcessInstancesPath();
    const processInstancesData = fs.readFileSync(processInstancesPath, 'utf8');
    const processInstances = JSON.parse(processInstancesData).processInstances;

    const instanceDetails = [];

    for (const instance of processInstances) {
        // Map roles to participants with keys and wallet addresses
        const participantRoles = instance.map(role => {
            if (participants[role]) {
                return {
                    role,
                    publicKey: participants[role].publicKey,
                    wallet: participants[role].wallet
                };
            } else {
                console.error(`Role ${role} not found for instance.`);
                return null;
            }
        }).filter(entry => entry !== null); // Filter out any null entries

        if (participantRoles.length === instance.length) {
            const participantKeys = participantRoles.map(entry => entry.publicKey);

            const txResponse = await processContract.newInstance.send(participantKeys, {
                gasLimit: 1000000
            });
            await txResponse.wait();

            const instanceID = await processContract.instancesCount();

            // Store instance details
            instanceDetails.push({
                instanceID,
                participants: participantRoles
            });

            console.log(`Instance ${instanceID} with participants:`, participantRoles);
        } else {
            console.error(`Could not create instance for: ${instance}`);
        }
    }

    return instanceDetails;
}

// Generate a random log of instance sequences
/**
 * Generates a random log of instance sequences for the specified number of entries.
 *
 * @param {number} instanceCount - The total number of instances available.
 * @param {number} entries - The number of log entries to generate.
 * @returns {Array<Array<number>>} - An array of entries, where each entry is an array containing instance IDs in random order.
 */
function generateRandomLog(instanceCount, entries) {
    const log = [];
    const instances = Array.from({ length: instanceCount }, (_, i) => i); // Generate instance IDs [0, 1, ..., instanceCount-1]

    for (let i = 0; i < entries; i++) {
        // Shuffle the instances array to create a random order
        const shuffledInstances = shuffleArray(instances.slice()); // Create a shuffled copy of the instances array
        log.push(shuffledInstances);
    }

    return log;
}

// Shuffle an array
/**
 * Shuffles an array in place using the Fisher-Yates algorithm.
 *
 * @param {Array} array - The array to shuffle.
 * @returns {Array} - The shuffled array.
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // Swap elements
    }
    return array;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

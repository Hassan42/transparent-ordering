const hre = require("hardhat");
const { ethers } = require("hardhat");
const { getParticipants } = require('./helper');
const fs = require('fs');
const path = require('path');
const cliProgress = require('cli-progress');

const dataDir = path.join(__dirname, '..', 'data'); // Define your data directory

// Contracts definition
let processContract;
let orderingContract;

// Instances with participants data
let instancesDetails;


// Tasks Information
const taskSenderMap = {
    "PurchaseOrder": "customer",
    "ConfirmOrder": "retailer",
    "RestockRequest": "retailer",
    "ConfirmRestock": "manufacturer",
    "CancelOrder": "customer"
};
const taskReceiverMap = {
    "PurchaseOrder": "retailer",
    "ConfirmOrder": "customer",
    "RestockRequest": "manufacturer",
    "ConfirmRestock": "retailer",
    "CancelOrder": "retailer"
};

// Nonce data for every participant
const nonceMap = new Map();

// Event log
const logs = [];

async function main() {
    const epochs = 500;
    const randomLogArg = process.env.RANDOM_LOG_PATH; // Get randomLog from command-line arguments if provided

    let randomLog;
    // Retrieve participants and validate against process instances
    const participants = await getParticipantsAndValidate();
    if (!participants) return;

    console.log("Deploying contracts...");

    // Deploy contracts
    await deployContracts();

    // Listen to emitted events
    listenForEvents();

    // Create process instances and log instance details
    instancesDetails = await createProcessInstances(participants);

    // Generate a random log with the desired number of entries
    // If randomLog argument is provided, parse it; otherwise, generate it
    if (randomLogArg) {
        try {
            randomLog = JSON.parse(fs.readFileSync(randomLogArg, 'utf8'));
        } catch (error) {
            console.error("Failed to load provided randomLog. Please ensure it's a valid JSON file.");
            return;
        }
    } else {
        console.log("Generating new log...");
        randomLog = generateRandomLog(instancesDetails.length, epochs); // Generate randomLog if not provided
        writeJsonToFile(dataDir, 'randomLog', randomLog); // Write randomLog to data directory
    }
    

    console.log("Starting process instances...");
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(randomLog.length, 0); // Start with total length of randomLog

    for (let i = 0; i < randomLog.length; i++) {
        const instanceOrder = randomLog[i];

        // Map each instanceID in the current order
        const executionPromises = instanceOrder.map(async ({ instanceID, deferredChoice }) => {
            const instance = instancesDetails.find(inst => inst.instanceID === instanceID);
            if (!instance) {
                console.error(`Instance ${instanceID} not found.`);
                return;
            }
            return executeInstance(instance, deferredChoice); // Pass deferredChoice to executeInstance
        });

        // Wait for all `executeInstance` calls in the current `instanceOrder` to complete
        await Promise.all(executionPromises);
        // Reset state of every instance
        await resetState();
        progressBar.update(i + 1);
    }

    progressBar.stop(); // Stop the progress bar when the loop completes
    console.log('All instances have been executed successfully.');
    // Write updated logs back to the file
    writeJsonToFile(dataDir, "logs", logs);
    saveDiscoLog(dataDir, "discoLog");
    process.exit(0); // Terminate the process when progress bar completes

}

async function executeInstance(instance, deferredChoice) {

    const participants = {
        customer: instance.participants.find(p => p.role.startsWith('customer')),
        retailer: instance.participants.find(p => p.role.startsWith('retailer')),
        manufacturer: instance.participants.find(p => p.role.startsWith('manufacturer'))
    };

    // Check if all required participants are present
    const missingRoles = Object.entries(taskSenderMap)
        .map(([task, role]) => (!participants[role] ? role : null))
        .filter(Boolean);

    if (missingRoles.length > 0) {
        throw new Error(`Missing roles in instance ${instance.instanceID}: ${missingRoles.join(", ")}`);
    }

    let openTasks = await fetchProcessState(instance.instanceID);

    // Process tasks until no more open tasks are left
    while (openTasks.length !== 0) {
        // If there's only one open task, execute it with the designated participant
        if (openTasks.length === 1) {
            const task = openTasks[0];
            const participantRole = taskSenderMap[task];
            const participant = participants[participantRole];
            await executeTask(instance.instanceID, task, participant);
        } else {
            // Use deferredChoice to decide between ConfirmRestock or CancelOrder
            for (const choice of deferredChoice) {
                const task = choice === 1 ? "ConfirmRestock" : "CancelOrder";
                const participantRole = taskSenderMap[task];
                const participant = participants[participantRole];
                await executeTask(instance.instanceID, task, participant);
            }
        }

        // Update the open tasks list after executing tasks
        openTasks = await fetchProcessState(instance.instanceID);
    }

    //Reset State of the instance (not a task, seperate from process to avoid fees)
    // await executeTask(instance.instanceID, "resetInstanceState", participants.customer);
}

async function executeTask(instanceID, taskName, participant) {
    const participantSigner = participant.wallet.connect(ethers.provider);
    const contractWithParticipant = processContract.connect(participantSigner);
    const contractFunction = contractWithParticipant["executeTask"];
    let txResponse;

    while (true) {
        try {
            // Retrieve and update nonce for the participant
            let currentNonce;
            if (nonceMap.has(participant.publicKey)) {
                // Use the next nonce in sequence if participant has a stored nonce
                currentNonce = nonceMap.get(participant.publicKey) + 1;
            } else {
                // Get the latest nonce from the network if no nonce is stored
                currentNonce = await ethers.provider.getTransactionCount(participant.publicKey, 'latest');
            }
            nonceMap.set(participant.publicKey, currentNonce);

            // Send the transaction with the assigned nonce
            txResponse = await contractFunction(instanceID, taskName, {
                gasLimit: 10000000,
                nonce: currentNonce,
            });

            // Wait for the transaction to complete and return the receipt
            const receipt = await txResponse.wait();

            // Update nonce map to next expected nonce after successful transaction
            nonceMap.set(participant.publicKey, currentNonce);
            return receipt;

        } catch (error) {
            if (error.code === 'NONCE_EXPIRED' ||
                error.message.includes('nonce too low') ||
                error.message.includes('replacement transaction underpriced')) {
                // console.warn(`Nonce too low for participant ${participant.role}, retrying with updated nonce.`);
                // Clear nonce cache for this participant to force a fresh fetch in the next attempt
                nonceMap.delete(participant.publicKey);
                await delay(500);
            } else {
                // Task not open: revert
                return;
            }
        }
    }
}

async function resetState() {
    try {
        // Reset state of the instance
        const txResponse = await processContract.resetData({
            gasLimit: 10000000
        });
        const receipt = await txResponse.wait();
        return receipt;
    } catch (error) {
        console.error(`Error resetting state`, error);
    }
}

// Helper function to introduce a delay
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchProcessState(instanceID) {
    try {
        // Fetch the open tasks for the specified instanceID using staticCall
        const openTasks = await processContract.getProcessState.staticCall(instanceID);
        return openTasks;
    } catch (error) {
        console.error(`Error fetching process state for instance ${instanceID}:`, error);
    }
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
            console.warn(`Role ${role} not found`);
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
    processContract = await ProcessContract.deploy();
    // console.log(`ProcessContract deployed at: ${processContract.target}`);

    const OrderingContract = await ethers.getContractFactory("OrderingContract");
    orderingContract = await OrderingContract.deploy(processContract.target);
    // console.log(`OrderingContract deployed at: ${orderingContract.target}`);
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
async function createProcessInstances(participants) {
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

            const instanceID = Number(await processContract.instancesCount());

            // Store instance details
            instanceDetails.push({
                instanceID,
                participants: participantRoles
            });

            // console.log(`Instance ${instanceID} with participants:`, participantRoles);
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
    const instances = Array.from({ length: instanceCount }, (_, i) => i + 1); // Generate instance IDs [1, 2, ..., instanceCount]

    for (let i = 0; i < entries; i++) {
        // Shuffle the instances array to create a random order
        const shuffledInstances = shuffleArray(instances.slice()); // Create a shuffled copy of the instances array

        // Combine instanceID with the fixed deferredChoice
        const entry = shuffledInstances.map(instanceID => ({
            instanceID,
            deferredChoice: Math.random() < 0.5 ? [0, 1] : [1, 0] // Randomly assign one of the two valid pairs
        }));

        log.push(entry);
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

async function listenForEvents() {
    // Listen for InstanceCreated event
    processContract.on("InstanceCreated", async (instanceID, event) => {
        const transactionHash = event.log.transactionHash;
        const eventData = { instanceID: instanceID.toString() };
        await logEvent("InstanceCreated", eventData, transactionHash);
    });

    // Listen for NewPrice event
    processContract.on("NewPrice", async (instanceID, newPrice, requestCount, event) => {
        const transactionHash = event.log.transactionHash
        const eventData = {
            instanceID: instanceID.toString(),
            newPrice: newPrice.toString(),
            requestCount: requestCount.toString()
        };
        await logEvent("NewPrice", eventData, transactionHash);
    });

    // Listen for TaskCompleted event
    processContract.on("TaskCompleted", async (instanceID, taskName, event) => {
        // Retrieve participant role based on taskName
        const senderRole = taskSenderMap[taskName];
        const receiverRole = taskReceiverMap[taskName];
        const instance = instancesDetails.find(inst => inst.instanceID === Number(instanceID));
        const sender = instance.participants.find(p => p.role.startsWith(senderRole));
        const receiver = instance.participants.find(p => p.role.startsWith(receiverRole));
        const transactionHash = event.log.transactionHash;

        const eventData = {
            instanceID: instanceID.toString(),
            taskName: taskName,
            sender: sender.role,
            receiver: receiver.role
        };
        await logEvent("TaskCompleted", eventData, transactionHash);
    });

    // Keep the script running to listen for events
    console.log("Listening for events...");
}

async function logEvent(eventName, eventData, transactionHash) {
    const receipt = await ethers.provider.getTransactionReceipt(transactionHash);

    // Add new log entry
    logs.push({
        event: eventName,
        data: eventData,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber.toString(),
        timestamp: new Date().toISOString(),
    });
}

function saveDiscoLog(dir, fileName) {
    // Initialize an object to hold prices by instanceID
    const pricesByInstanceID = {};

    logs.forEach(log => {
        const { event, data } = log;
        
        // If the event is "NewPrice", store the price by instanceID
        if (event === "NewPrice") {
            pricesByInstanceID[data.instanceID] = data.newPrice; 
        }
    });

    const discoLogs = logs.map(log => {
        const { event, data, gasUsed, blockNumber, timestamp } = log;

        // If the event is "NewPrice", store the price by instanceID
        if (event === "NewPrice") {
            return; // Skip
        }

        // If the event is "TaskCompleted", replace event value with taskName
        const newEvent = event === "TaskCompleted" ? data.taskName : event;

        // Prepare the transformed entry
        const transformedEntry = {
            event: newEvent,
            gasUsed,
            blockNumber,
            timestamp,
            instanceID: data.instanceID, // Include instanceID directly
            sender: event === "TaskCompleted" ? (data.sender || null) : null, // Set sender to null if not present
            receiver: event === "TaskCompleted" ? (data.receiver || null) : null, // Set receiver to null if not present
            price: null // Initialize price as null
        };

        // If the event is "RestockRequest", add the corresponding price
        if (event === "TaskCompleted" && data.taskName == "RestockRequest") {
            transformedEntry.price = pricesByInstanceID[data.instanceID] || null; // Add the price for the specific instanceID
        }

        return transformedEntry;
    }).filter(entry => entry !== undefined);

    // Function to convert JSON to CSV format
    const jsonToCsv = (json) => {
        if (json.length === 0) return ''; // Handle empty input

        const headers = Object.keys(json[0]);
        const csvRows = [
            headers.join(','), // Join headers
            ...json.map(row =>
                headers.map(header => JSON.stringify(row[header] || '')).join(',') // Join each row
            ) // Correctly close the parentheses
        ];
        return csvRows.join('\n'); // Join all rows with a new line
    };

    // Convert discoLogs to CSV
    const csvData = jsonToCsv(discoLogs);

    // Write CSV to file
    const filePath = path.join(dir, `${fileName}.csv`);
    try {
        fs.writeFileSync(filePath, csvData);
        console.log(`Disco CSV file has been written successfully to ${filePath}!`);
    } catch (err) {
        console.error('Error writing to CSV file', err);
    }
}

function writeJsonToFile(dir, filename, data) {
    // Ensure the directory exists
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true }); // Create the directory recursively if it doesn't exist
    }

    // Define the full path for the file
    const filePath = path.join(dir, `${filename}.json`);

    // Write the JSON data to the file
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    // console.log(`Data written to: ${filePath}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

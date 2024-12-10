const hre = require("hardhat");
const { ethers } = require("hardhat");
const { getParticipants } = require('./helper');
const fs = require('fs');
const path = require('path');
const cliProgress = require('cli-progress');
const EventEmitter = require("events");

const dataDir = path.join(__dirname, '..', 'data'); // Define your data directory

const eventEmitter = new EventEmitter();

// Contracts definition
let processContract;
let orderingContract;

// Instances with participants data
let instancesDetails;

// Tasks Information (Could be fetched from smart contract or other sources)
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

// Delays between ech round
const ROUND_DELAY = 1000;

let global_execution_count = 0;

// Rounds 
const rounds = 1;

async function main() {

    const randomLogArg = process.env.RANDOM_LOG_PATH; // Get randomLog from command-line arguments if provided

    // Retrieve participants and validate against process instances
    const participants = await getParticipantsAndValidate();
    if (!participants) return;

    console.log(participants)

    await deployContracts();

    checkAndEmitCanVoteEvent();

    listenForEvents();

    // Create process instances and log instance details
    instancesDetails = await createProcessInstances(participants);

    const randomLog = await setupRandomLog(randomLogArg, instancesDetails.length);

    await executeProcessInstances(randomLog);

    saveResults();

    process.exit(0); // Terminate the process when progress bar completes

}

// Generate a random log with the desired number of entries
// If randomLog argument is provided, parse it; otherwise, generate it
async function setupRandomLog(randomLogArg, instanceCount) {
    let randomLog;
    if (randomLogArg) {
        try {
            randomLog = JSON.parse(fs.readFileSync(randomLogArg, 'utf8'));
        } catch (error) {
            console.error("Failed to load provided randomLog. Please ensure it's a valid JSON file.");
            process.exit(1);
        }
    } else {
        console.log("Generating new log...");
        randomLog = generateRandomLog(instanceCount, rounds);
        writeJsonToFile(dataDir, 'randomLog', randomLog);
    }
    return randomLog;
}

async function executeProcessInstances(randomLog) {
    console.log("Starting process instances...");
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(randomLog.length, 0);

    for (let i = 0; i < randomLog.length; i++) {
        const { instances: instanceOrder, delay } = randomLog[i];

        await Promise.all(instanceOrder.map(async ({ instanceID, deferredChoice }) => {
            const instance = instancesDetails.find(inst => inst.instanceID === instanceID);
            if (!instance) {
                console.error(`Instance ${instanceID} not found.`);
                return;
            }
            return executeInstance(instance, deferredChoice);
        }));

        await resetState();
        progressBar.update(i + 1);

        if (delay) await makeDelay(ROUND_DELAY);
    }

    progressBar.stop();
    console.log("All instances have been executed successfully.");
}

function saveResults() {
    writeJsonToFile(dataDir, "logs", logs);
    saveDiscoLog(dataDir, "discoLog");
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
            await executeTaskOC(instance.instanceID, task, participant);
        } else {
            // Use deferredChoice to decide between ConfirmRestock or CancelOrder
            const choices = [];
            for (const choice of deferredChoice) {
                const task = choice === 1 ? "ConfirmRestock" : "CancelOrder";
                const participantRole = taskSenderMap[task];
                const participant = participants[participantRole];
                choices.push(executeTaskOC(instance.instanceID, task, participant));
            }
            // Wait for both choices to be resolved;
            await Promise.all(choices);
        }

        // Update the open tasks list after executing tasks
        openTasks = await fetchProcessState(instance.instanceID);
    }
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
                // await makeDelay(500);
            } else {
                // Task not open: revert
                return;
            }
        }
    }
}

async function executeTaskOC(instanceID, taskName, participant) {
    const participantSigner = participant.wallet.connect(ethers.provider);
    const contractWithParticipant = orderingContract.connect(participantSigner);
    const contractFunction = contractWithParticipant["submitInteraction"];
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
            // console.log(instanceID, taskName, "end epoch")
            // Wait for the InteractionPoolOpen event before returning
            await new Promise((resolve) => {
                orderingContract.once("InteractionPoolOpen", () => {
                    // console.log(instanceID, taskName, "next epoch")
                    resolve();
                });
            });

            return receipt;

        } catch (error) {
            if (error.code === 'NONCE_EXPIRED' ||
                error.message.includes('nonce too low') ||
                error.message.includes('replacement transaction underpriced')) {
                // console.warn(`Nonce too low for participant ${participant.role}, retrying with updated nonce.`);
                // Clear nonce cache for this participant to force a fresh fetch in the next attempt
                nonceMap.delete(participant.publicKey);
                // await makeDelay(500);
            } else {
                // Task not open: revert
                // console.error(error)
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

// Function to continuously check `canVote` and emit event when true
async function checkAndEmitCanVoteEvent() {
    while (true) {
        try {
            const canVote = await orderingContract.canVote();

            if (canVote) {
                // Emit the "canVoteEvent" with some data
                eventEmitter.emit("canVoteEvent", { message: "canVote is true!" });
                break; // Stop the loop after emitting the event
            }
        } catch (error) {
            console.error("Error checking canVote:", error);
            break; // Stop the loop on error to avoid infinite retries
        }
    }
}

// Helper function to introduce a delay
async function makeDelay(ms) {
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
    console.log("Deploying contracts...");
    try {
        const ProcessContract = await ethers.getContractFactory("ProcessContract");
        processContract = await ProcessContract.deploy();
        console.log(`ProcessContract deployed at: ${processContract.target}`);

        const OrderingContract = await ethers.getContractFactory("OrderingContract");
        orderingContract = await OrderingContract.deploy(processContract.target);
        console.log(`OrderingContract deployed at: ${orderingContract.target}`);

        await makeDelay(8000); // ethers will crash if we dont wait some time for the contract to be confirmed (unable to call view functions) (??)

        await processContract.setOrderingContractAddress(orderingContract.target);

    } catch (error) {
        console.error("Error deploying contracts:", error);
    }

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

/**
 * Generates a random log of instance sequences for the specified number of entries.
 *
 * @param {number} instanceCount - The total number of instances available.
 * @param {number} entries - The number of log entries to generate.
 * @returns {Array<Object>} - An array of log entries, where each entry is an object containing an array of instances and a delay flag.
 */
function generateRandomLog(instanceCount, entries) {
    const log = [];
    const instances = Array.from({ length: instanceCount }, (_, i) => i + 1); // Generate instance IDs [1, 2, ..., instanceCount]

    for (let i = 0; i < entries; i++) {
        // Shuffle the instances array to create a random order
        const shuffledInstances = shuffleArray(instances.slice()); // Create a shuffled copy of the instances array

        // Map the shuffled instances to objects with instanceID and deferredChoice
        const instanceSequence = shuffledInstances.map(instanceID => ({
            instanceID,
            deferredChoice: Math.random() < 0.5 ? [0, 1] : [1, 0] // Randomly assign one of the two valid pairs
        }));

        // Add the entry with the instance sequence and a random delay
        log.push({
            instances: instanceSequence,
            delay: Math.random() < 0.5 // Randomly assign true or false for delay
        });
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
    // Create a shallow copy of the array to avoid modifying the original
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]]; // Swap elements
    }
    return newArray;
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

    // Listen for NewPrice event
    orderingContract.on("Conflict", async (domainId) => {
        console.log("conflict detected in domain in ", domainId);
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

        //Increase execution count
        if (taskName == "PurchaseOrder") {
            instance.execution_count = 1 + global_execution_count++;
        }

        const eventData = {
            instanceID: instanceID.toString(),
            taskName: taskName,
            sender: sender.role,
            receiver: receiver.role,
            executionCount: instance.execution_count,
        };
        await logEvent("TaskCompleted", eventData, transactionHash);
    });

    // Local event to know when to vote
    eventEmitter.on("canVoteEvent", async (data) => {
        console.log("canVoteEvent triggered:", data.message);
        await orderingVotes();
    });

    // Keep the script running to listen for events
    console.log("Listening for events...");
}

async function orderingVotes() {

    const domains = [];
    const indexBlock = await orderingContract.index_block();
    console.log("Index blocks", indexBlock);
    
    const domainCount = await orderingContract.domain_count();

    for (let i = 1; i <= domainCount; i++) {
        const domain = await orderingContract.getDomainByIndex(i);

        // Push the updated domain to the domains array
        domains.push(domain);
        console.log(domain);
    }

    if (domainCount == 0){
        console.log("Releasing isolated interactions.")
        try{
            await orderingContract.release();
        }
        catch(error){
            console.error("Failed to release.")
        }
    }

    // const inters = await orderingContract.getPendingInteractionsStruct();
    // console.log("interactions: ", inters)

    //Filter only valid orderer
    const externalOrderers = await orderingContract.getExternalOrderersForEpoch(indexBlock);

    const validExternalOrderers = externalOrderers.filter(orderer => orderer.valid);

    if (validExternalOrderers.length != 0) {
       
        console.log("External Orderers Voting");
        const pendingInteractions = await orderingContract.getPendingInteractions();

        for (let i = 0; i < validExternalOrderers.length ; i++) {

            let indicesToReorder = shuffleArray(pendingInteractions); // TODO: different strategy to order

            indicesToReorder = indicesToReorder.map(index => Number(index));

            console.log(validExternalOrderers[i][0], indicesToReorder)

            // TODO: Check if epoch is not conflicted

            let tx = await orderingContract.orderInteractionExternal(indicesToReorder);

            await tx.wait();
        }
    }

    else {
        console.log("Domains Orderers Voting");
        // Get the total domain count

        // Fetch all pending interactions

        // Array to hold the domains

        console.log("domain count", domainCount)


        // console.log("interactions", pendingInteractions)
        // Loop through each domain to get their details
        for (let i = 1; i <= domainCount; i++) {
            const domain = await orderingContract.getDomainByIndex(i);

            // Push the updated domain to the domains array
    

            // Populate the orderers array for the current domain
            for (let j = 0; j < domain.orderers.length; j++) {

                if (domain.status != Number(0)) {
                    continue;
                }

                const ordererAddress = domain.orderers[j];

                // Fetch the pending interactions for the current orderer
                const pendingInteractionsForOrderer = await orderingContract.getPendingInteractionsForOrderer(domain.id, ordererAddress);
                

                let indicesToReorder = shuffleArray(pendingInteractionsForOrderer); // TODO: different strategy to order
       
                // Convert domain ID and indices if necessary
                let domainId = Number(domain.id); // Or domain.domainId, if that's correct
                indicesToReorder = indicesToReorder.map(index => Number(index));
                console.log(ordererAddress, indicesToReorder)


                let tx = await orderingContract.orderInteraction(domainId, indicesToReorder);

                await tx.wait();

            }
        }
    }

    // Check for the next ordering phase
    checkAndEmitCanVoteEvent();
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
            executionCount: event === "TaskCompleted" ? (data.executionCount || null) : null,
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
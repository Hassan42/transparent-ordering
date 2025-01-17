const hre = require("hardhat");
const { ethers } = require("hardhat");
const { getParticipants } = require('./helper');
const fs = require('fs');
const path = require('path');
const cliProgress = require('cli-progress');
const EventEmitter = require("events");
const seedrandom = require('seedrandom');

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

// Store gas usage by round
const roundMetrics = {};

// Delays between ech round
const ROUND_DELAY = 1500;

let global_execution_count = 0;

// Rounds 
let rounds;

let strategy;

let logging = true;

let setting;

let conflictCheckProbability = 90;

let round = 0;

let epochs_count = 0;

const domains = [];
const externalOrderer = []; //for logging

async function main() {

    const randomLogArg = process.env.RANDOM_LOG_PATH; // Get randomLog from command-line arguments if provided
    strategy = process.env.STRATEGY;
    rounds = process.env.ROUNDS;
    logging = process.env.LOGGING;
    setting = process.env.SETTING;

    if (!strategy) {
        strategy = 0; // Intermediate by default
    }

    if (!rounds) {
        rounds = 1;
    }

    if (!setting) {
        setting = "PLAIN";
    }

    // Retrieve participants and validate against process instances
    const participants = await getParticipantsAndValidate();
    if (!participants) return;

    Logger.log(participants)

    await deployContracts();

    if (setting == "OC") {
        checkAndEmitCanVoteEvent();
    }

    listenForEvents();

    // Create process instances and log instance details
    instancesDetails = await createProcessInstances(participants);

    const randomLog = await setupRandomLog(randomLogArg, instancesDetails.length);

    await executeProcessInstances(randomLog);

    await extractDomains();

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
        Logger.log("Generating new log...");
        randomLog = generateRandomLog(instanceCount, rounds);
        writeJsonToFile(dataDir, 'randomLog', randomLog);
    }
    return randomLog;
}

async function executeProcessInstances(randomLog) {
    Logger.log("Starting process instances...");
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(randomLog.length, 0);

    for (let i = 0; i < randomLog.length; i++) {
        const { instances: instanceOrder, delay } = randomLog[i];

        const roundStartTime = Date.now(); // Record the start time

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

        const roundEndTime = Date.now(); // Record the end time
        const roundDuration = roundEndTime - roundStartTime;

        if (!roundMetrics[round]) {
            roundMetrics[round] = {
                duration: 0,
            };
        }

        roundMetrics[round].duration = roundDuration;

        saveResults();

        round += 1;
    }

    progressBar.stop();
    Logger.log("All instances have been executed successfully.");
}

function saveResults() {
    writeJsonToFile(dataDir, "logs", logs);
    saveDiscoLog(dataDir, "discoLog");
    writeJsonToFile(dataDir, "domains", domains);
    writeJsonToFile(dataDir, "roundMetrics", roundMetrics);
    writeJsonToFile(dataDir, "externalOrderers", externalOrderer);
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

    let executeTaskFunction = executeTask;
    if (setting == "OC") {
        executeTaskFunction = executeTaskOC;
    }

    // Process tasks until no more open tasks are left
    while (openTasks.length !== 0) {
        // If there's only one open task, execute it with the designated participant
        if (openTasks.length === 1) {
            const task = openTasks[0];
            const participantRole = taskSenderMap[task];
            const participant = participants[participantRole];
            await executeTaskFunction(instance.instanceID, task, participant);
        } else {
            // Use deferredChoice to decide between ConfirmRestock or CancelOrder
            const choices = [];
            for (const choice of deferredChoice) {
                const task = choice === 1 ? "ConfirmRestock" : "CancelOrder";
                const participantRole = taskSenderMap[task];
                const participant = participants[participantRole];
                choices.push(executeTaskFunction(instance.instanceID, task, participant));
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
            storeGasUsage(round, receipt);

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
            storeGasUsage(round, receipt);

            // Update nonce map to next expected nonce after successful transaction
            nonceMap.set(participant.publicKey, currentNonce);
            Logger.log(`${instanceID} , ${taskName}, start epoch`)
            // Wait for the InteractionPoolOpen event before returning
            await new Promise((resolve) => {
                orderingContract.once("InteractionPoolOpen", () => {
                    Logger.log(`${instanceID} , ${taskName}, end epoch`)
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
                eventEmitter.emit("canVoteEvent");
                return; // Stop the loop after emitting the event
            }

            await makeDelay(300);
        } catch (error) {
            console.error("Error checking canVote:", error);
            // break; // Stop the loop on error to avoid infinite retries
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
    Logger.log("Deploying contracts...");
    try {

        const ProcessContract = await ethers.getContractFactory("ProcessContract");
        processContract = await ProcessContract.deploy();
        Logger.log(`ProcessContract deployed at: ${processContract.target}`);

        try {
            const OrderingContract = await ethers.getContractFactory("OrderingContract");
            orderingContract = await OrderingContract.deploy(processContract.target, strategy);
            Logger.log(`OrderingContract deployed at: ${orderingContract.target}`);
        }
        catch (error) {
            console.log(error);
        }

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



            console.log(`Instance ${instanceID} with participants:`, participantRoles);
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


function enhancedshuffleArray(array, seed, passes = 3) {
    let rng = seedrandom(seed); // Initialize a seeded random generator
    let shuffled = [...array];

    for (let pass = 0; pass < passes; pass++) {
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        // Re-seed with a new seed for the next pass to add entropy
        rng = seedrandom(seed + pass.toString() + Math.random().toString());
    }

    return shuffled;
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
        const transactionHash = event.log.transactionHash;
        const instance = instancesDetails.find(inst => inst.instanceID === Number(instanceID));
        const eventData = {
            instanceID: instanceID.toString(),
            newPrice: newPrice.toString(),
            requestCount: requestCount.toString(),
            executionCount: instance.execution_count
        };
        await logEvent("NewPrice", eventData, transactionHash);
    });

    // Listen for NewPrice event
    orderingContract.on("Conflict", async (domainId, event) => {
        const transactionHash = event.log.transactionHash;
        const eventData = {
            instanceID: domainId.toString(),
        };
        await logEvent("Conflict", eventData, transactionHash);
        Logger.log(`conflict detected in domain in ${domainId}`);
    });

    orderingContract.on("InteractionPoolOpen", async (event) => {
        const transactionHash = event.log.transactionHash;
        epochs_count++;
        const eventData = {
            epochs_count,
        };
        await logEvent("NewEpoch", eventData, transactionHash);
        Logger.log(`new epoch. ${epochs_count}`);
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

        //Increase confirm order
        if (taskName == "ConfirmOrder") {
            // instanceCounts[instanceID.toString()] = (instanceCounts[instanceID.toString()] || 0) + 1;
        }

        if (taskName == "CancelOrder") {
            if (instanceID.toString() == 2 || instanceID.toString() == 3) {
                cancelConfirmCounts["CancelOrder"]++;
            }
        }

        if (taskName == "ConfirmRestock") {
            if (instanceID.toString() == 2 || instanceID.toString() == 3) {
                cancelConfirmCounts["ConfirmRestock"]++;
            }
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
        // await makeDelay(9000);
        await orderingVotes();
    });

    // Keep the script running to listen for events
    Logger.log("Listening for events...");
}


async function orderingVotes() {

    const pendingInteractionsStruct = await orderingContract.getPendingInteractionsStruct();
    console.log("INTERS:", pendingInteractionsStruct);
    // Logger.log(`Epoch Voting Phase ${epochs_count}`);
    const indexBlock = await orderingContract.index_block();
    Logger.log(`Index blocks ${indexBlock}`);

    const domainCount = await orderingContract.domain_count();
    const conflictAllowed = Math.random() * 100 >= conflictCheckProbability;

    const canRelease = await orderingContract.canRelease();

    console.log("can release:,", canRelease);

    // const interactions = await orderingContract.getPendingInteractionsStruct();

    if (canRelease) {
        try {
            Logger.log("Releasing isolated interactions.");
            await orderingContract.release();
        } catch (error) {
            console.error("Failed to release isolated interactions.");
            console.log(await orderingContract.index_block());
        }
    }

    const externalOrderers = await orderingContract.getExternalOrderersForEpoch(indexBlock);
    const validExternalOrderers = externalOrderers.filter(orderer => orderer.valid);

    if (validExternalOrderers.length !== 0) {
        Logger.log("External Orderers Voting");
        externalOrderer.push(validExternalOrderers);


        await handleVoting(
            validExternalOrderers,
            () => orderingContract.getPendingInteractions(),
            (order) => orderingContract.orderInteractionExternal(order),
            conflictAllowed,
            "External"
        );

    } else {
        Logger.log("Domains Orderers Voting");
        for (let i = 1; i <= domainCount; i++) {
            const domain = await orderingContract.getDomainByIndex(i);

            if (domain.status != Number(0)) {
                continue;
            }

            console.log("DOMAIN:", domain);
            // const pendingInteractionsStruct = await orderingContract.getPendingInteractionsStruct();
            // console.log("INTERS:", pendingInteractionsStruct);

            await handleVoting(
                domain.orderers,
                (orderer) => orderingContract.getPendingInteractionsForOrderer(domain.id, orderer),
                (order) => orderingContract.orderInteraction(domain.id, order),
                conflictAllowed,
                `Domain ${i}`
            );
        }
    }
    await makeDelay(500);
    checkAndEmitCanVoteEvent();
}

/**
 * Handles the voting process for a set of orderers, including conflict resolution.
 * 
 * @param {Array} orderers - The orderers participating in the voting.
 * @param {Function} getInteractions - A function to fetch pending interactions for an orderer.
 * @param {Function} submitOrder - A function to submit the resolved order for an orderer.
 * @param {Boolean} conflictAllowed - Whether conflicts are allowed.
 * @param {String} context - A label to identify the voting context in logs.
 */
async function handleVoting(orderers, getInteractions, submitOrder, conflictAllowed, context) {
    const shuffledOrderers = shuffleArray(orderers);
    let currentOrder = [];

    // Build the initial order
    for (const orderer of shuffledOrderers) {
        const pendingInteractions = await getInteractions(orderer);
        currentOrder.push([...pendingInteractions]); // Add subarray for each orderer
    }

    currentOrder = shuffleArray(currentOrder);

    // Apply round-robin bias
    currentOrder = await applyRoundRobinBias(currentOrder);

    Logger.log(`${context} Current Order:`, currentOrder);

    // Handle conflict detection and resolution
    if (!conflictAllowed) {
        let conflictDetected = checkConflict(currentOrder);

        if (conflictDetected) {
            Logger.log(`Conflict detected in ${context}, attempting to resolve...`);

            while (conflictDetected) {
                // Shuffle the orderers and rebuild the newOrder based on the new orderer arrangement
                const reshuffledOrderers = shuffleArray(shuffledOrderers);
                let reshuffledOrder = [];

                for (const orderer of reshuffledOrderers) {
                    const pendingInteractions = await getInteractions(orderer);
                    reshuffledOrder.push([...pendingInteractions]); // Add subarray for each orderer
                }

                // Shuffle each subarray in the reshuffled order
                for (let i = 0; i < reshuffledOrder.length; i++) {
                    reshuffledOrder[i] = shuffleArray([...reshuffledOrder[i]]);
                }

                reshuffledOrder = await applyRoundRobinBias(reshuffledOrder);

                // Check for conflicts in the reshuffled order
                conflictDetected = checkConflict(reshuffledOrder);

                Logger.log(`Rechecking conflict for ${context}: [${reshuffledOrder}]`);

                // Update shuffledOrderers and currentOrder if no conflict
                if (!conflictDetected) {
                    Logger.log(`Conflict resolved for ${context}.`);
                    shuffledOrderers.splice(0, shuffledOrderers.length, ...reshuffledOrderers);
                    currentOrder.splice(0, currentOrder.length, ...reshuffledOrder);
                }
            }
        }
    }

    // Submit the orders
    for (let i = 0; i < shuffledOrderers.length; i++) {
        const orderer = shuffledOrderers[i];
        const order = currentOrder[i];

        Logger.log(`${context} Orderer ${orderer} submitting order: ${order}`);

        try {
            const tx = await submitOrder(order);
            const receipt = await tx.wait();
            storeGasUsage(round, receipt);
        } catch (error) {
            console.log(`${context} Orderer ${orderer} failed to submit order. ${error}`);
        }
    }

}

/**
 * Applies round-robin bias to the global order based on the current round.
 * 
 * @param {Array<Array<number>>} globalOrder - The global order of interactions as an array of subarrays.
 * @param {Array<Object>} pendingInteractionsStruct - The structure containing interaction details.
 * @param {number} currentRound - The current round (0 for bias to 3,4 and 1 for bias to 1,2).
 * @returns {Array<Array<number>>} - The updated global order with bias applied.
 */
// Initialize counters for CancelOrder and ConfirmRestock
// Initialize combined counters for CancelOrder and ConfirmRestock
let cancelConfirmCounts = { "CancelOrder": 0, "ConfirmRestock": 0 };

async function applyRoundRobinBias(globalOrder) {
    Logger.log("Applying round-robin bias.");

    const pendingInteractionsStruct = await orderingContract.getPendingInteractionsStruct();

    globalOrder.forEach((subOrderer, subOrderIndex) => {
        const biasedInteractions = [];
        const otherInteractions = [];

        subOrderer.forEach(index => {
            const interaction = pendingInteractionsStruct[index];
            const instanceID = BigInt(interaction.instanceID || interaction[0]);
            const interactionName = interaction.name || interaction[3];

            // PurchaseOrder Bias (Round-Based)
            if (interactionName === "PurchaseOrder") {
                if (Math.floor(round / 5) % 2 === 0) {
                    // Bias towards instanceID 3 and 4 for even rounds
                    //instanceID === 3n || instanceID === 4n
                    if (instanceID === 2n || instanceID === 3n) {
                        // Logger.log(`Biasing PurchaseOrder for instance 3 or 4: ${index}`);
                        biasedInteractions.push(index);
                    } else {
                        otherInteractions.push(index);
                    }
                } else {
                    // Bias towards instanceID 1 and 2 for odd rounds
                    //instanceID === 1n || instanceID === 2n
                    if (instanceID === 1n || instanceID === 4n) {
                        // Logger.log(`Biasing PurchaseOrder for instance 1 or 2: ${index}`);
                        biasedInteractions.push(index);
                    } else {
                        otherInteractions.push(index);
                    }
                }
            }
            // RestockRequest Bias (Round-Based)
            else if (interactionName === "RestockRequest") {
                if (Math.floor(round / 5) % 2 === 0) {
                    // Bias towards instanceID 1 and 3 for even rounds
                    //instanceID === 1n || instanceID === 3n
                    if (instanceID === 1n || instanceID === 2n) {
                        // Logger.log(`Biasing RestockRequest for instance 1 or 3: ${index}`);
                        biasedInteractions.push(index);
                    } else {
                        otherInteractions.push(index);
                    }
                } else {
                    // Bias towards instanceID 2 and 4 for odd rounds
                    //instanceID === 2n || instanceID === 4n
                    if (instanceID === 3n || instanceID === 4n) {
                        // Logger.log(`Biasing RestockRequest for instance 2 or 4: ${index}`);
                        biasedInteractions.push(index);
                    } else {
                        otherInteractions.push(index);
                    }
                }
            }

            // CancelOrder and ConfirmRestock Balancing
            else if (interactionName === "CancelOrder" || interactionName === "ConfirmRestock") {
                //instanceID === 1n || instanceID === 2n
                if (instanceID === 2n || instanceID === 3n) {
                    // Determine the task with the lowest count
                    const taskToBias = cancelConfirmCounts["CancelOrder"] <= cancelConfirmCounts["ConfirmRestock"]
                        ? "CancelOrder"
                        : "ConfirmRestock";

                    console.log(cancelConfirmCounts);

                    if (interactionName === taskToBias) {
                        // Logger.log(`Balancing task ${interactionName} for instance ${instanceID}: ${index}`);
                        biasedInteractions.push(index);
                        // cancelConfirmCounts[interactionName]++; // Increment the task count
                    } else {
                        otherInteractions.push(index);
                    }
                }
                else {
                    otherInteractions.push(index);
                }
            }
            // Default: Other interactions
            else {
                otherInteractions.push(index);
            }
        });

        // Update the specific subOrderer in the globalOrder
        globalOrder[subOrderIndex] = [...biasedInteractions, ...otherInteractions];
    });

    return globalOrder;
}





// let instanceCounts = { "1": 0, "2": 0, "3": 0, "4": 0 }; // Track counts for each instance
// let leadingInstance = null; // Instance currently leading
// let convergenceActive = false;

// async function applyRoundRobinBias(globalOrder, maxRounds=500) {
//     console.log("Instance counts:", instanceCounts);
//     Logger.log(`Applying bias for round ${round}.`);

//     const pendingInteractionsStruct = await orderingContract.getPendingInteractionsStruct();

//     // Sort instances by interaction counts
//     const sortedInstances = Object.entries(instanceCounts)
//         .sort(([, countA], [, countB]) => countA - countB)
//         .map(([instance]) => instance);

//     // Check if convergence should be triggered
//     const triggerConvergence = 
//         !convergenceActive &&
//         (Math.random() > 0.6 || round === maxRounds - 1 || round === Math.floor(maxRounds / 2));

//     if (triggerConvergence) {
//         Logger.log(`Convergence triggered at round ${round}.`);
//         convergenceActive = true;
//         leadingInstance = sortedInstances[sortedInstances.length - 1]; // Exclude the leading instance
//     }

//     // Check if convergence is complete
//     if (convergenceActive) {
//         const leadingCount = instanceCounts[leadingInstance];
//         const allCaughtUp = Object.values(instanceCounts).every(count => count >= leadingCount);

//         if (allCaughtUp) {
//             Logger.log(`Convergence complete at round ${round}.`);
//             convergenceActive = false;
//             leadingInstance = null; // Reset leading instance
//         }
//     }

//     // Apply bias
//     globalOrder.forEach((subOrderer, subOrderIndex) => {
//         const biasedInteractions = [];
//         const otherInteractions = [];

//         subOrderer.forEach(index => {
//             const interaction = pendingInteractionsStruct[index];
//             const instanceID = BigInt(interaction.instanceID || interaction[0]);
//             const interactionName = interaction.name || interaction[3];

//             if (convergenceActive) {
//                 // During convergence, exclude leading instance
//                 if (
//                     instanceID.toString() !== leadingInstance &&
//                     interactionName === "PurchaseOrder"
//                 ) {
//                     biasedInteractions.push(index);
//                 } else {
//                     otherInteractions.push(index);
//                 }
//             } else {
//                 // Randomly select instances outside convergence
//                 if (
//                     Math.random() > 0.5 &&
//                     interactionName === "PurchaseOrder"
//                 ) {
//                     biasedInteractions.push(index);
//                 } else {
//                     otherInteractions.push(index);
//                 }
//             }
//         });

//         // Update the specific subOrderer in the globalOrder
//         globalOrder[subOrderIndex] = [...biasedInteractions, ...otherInteractions];
//     });

//     return globalOrder;
// }



/**
 * Function to check if a flattened global order causes conflicts.
 * A conflict occurs when the same index appears out of order, creating a cycle.
 *
 * @param {Array<Array<number>>} globalOrder - Array of subarrays representing each orderer's interactions.
 * @returns {boolean} - True if a conflict is detected, false otherwise.
 */
function checkConflict(globalOrder) {
    let orderedInteractions = []; // Simulate the domain's ordered_interactions

    for (let i = 0; i < globalOrder.length; i++) {
        const subArray = globalOrder[i];
        let anchorIndex = -1; // Reset the anchor index for each subArray

        // Add the subArray to the orderedInteractions while maintaining the order
        for (let j = 0; j < subArray.length; j++) {
            const currentIndex = subArray[j];
            const existingIndex = orderedInteractions.indexOf(currentIndex);

            if (existingIndex === -1) {
                // Element does not exist, insert at the top if no anchor, otherwise after the anchor
                if (anchorIndex === -1) {
                    orderedInteractions.unshift(currentIndex); // Insert at the top
                } else {
                    orderedInteractions.splice(anchorIndex + 1, 0, currentIndex); // Insert after the anchor
                }
                anchorIndex = orderedInteractions.indexOf(currentIndex); // Update the anchor index
            } else {
                // If element already exists, check for conflicts
                if (existingIndex >= anchorIndex) {
                    anchorIndex = existingIndex; // Update the anchor to the latest position
                } else {
                    // Conflict detected: interaction appears out of sequence
                    return true;
                }
            }
        }
    }

    // No conflicts detected
    return false;
}

async function extractDomains() {
    const domainCount = await orderingContract.domain_count();
    for (let i = 1; i <= domainCount; i++) {
        const domain = await orderingContract.getDomainByIndex(i);
        domains.push(domain);
    }
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
        round,
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
        Logger.log(`Disco CSV file has been written successfully to ${filePath}!`);
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

    // Convert data to JSON, handling BigInt values
    const jsonData = JSON.stringify(data, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
        2
    );

    // Write the JSON data to the file
    fs.writeFileSync(filePath, jsonData, 'utf8');
    console.log(`Data written to: ${filePath}`);
}

/**
 * Function to store gas usage for a specific round.
 * @param {number} round - The current round number.
 * @param {Object} receipt - The transaction receipt containing gas usage and transaction details.
 */
function storeGasUsage(round, receipt) {
    // Initialize the round if it doesn't exist
    if (!roundMetrics[round]) {
        roundMetrics[round] = {
            gasUsage: [], // Initialize an array to store gas usage
        };
    }

    // Extract gas used and transaction hash
    const gasUsed = receipt.gasUsed.toString(); // Convert gas used to a string

    // Add the gas usage for the transaction to the round
    roundMetrics[round].gasUsage.push({
        gasUsed: gasUsed,
    });
}


const Logger = (() => {
    let enabled = logging; // Logging is enabled by default

    // Function to enable or disable logging
    function setEnabled(state) {
        enabled = state;
    }

    // Function to log messages if logging is enabled
    function log(message) {
        if (enabled) {
            console.log(message);
        }
    }

    return {
        setEnabled,
        log,
    };
})();

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
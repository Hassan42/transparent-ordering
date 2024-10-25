const hre = require("hardhat");
const { ethers } = require("hardhat");
const { getParticipants } = require('./helper');
const fs = require('fs');
const path = require('path');


async function main() {

    const parentPath = path.dirname(__filename);
    const processInstancesPath = path.join(parentPath, '..', 'QBFT-Network', 'processInstances.json');

    if (!fs.existsSync(processInstancesPath)) {
        console.error('processInstances.json not found at:', processInstancesPath);
        return;
    }

    // Call the function to retrieve participant keys and roles
    const participants = await getParticipants();

    console.log('Participants:', participants);

    // Read the processInstances.json file
    const processInstancesData = fs.readFileSync(processInstancesPath, 'utf8');
    const processInstances = JSON.parse(processInstancesData).processInstances;

    // Check each process instance against the participants object using roles
    const allRolesMatch = processInstances.every(instance => {
        return instance.every(role => {
            // Check if the role exists in the participants object
            if (participants[role]) {
                return true;
            } else {
                console.log(`Role ${role} not found`);
                return false;
            }
        });
    });

    if (allRolesMatch) {
        console.log('All roles match.');
    } else {
        console.error('Mismatch in roles.');
        return;
    }

    // Deploy ProcessContract
    const ProcessContract = await ethers.getContractFactory("ProcessContract");
    const processContract = await ProcessContract.deploy();
    console.log(`ProcessContract deployed at: ${processContract.target}`);

    // Deploy OrderingContract
    const OrderingContract = await ethers.getContractFactory("OrderingContract");
    const orderingContract = await OrderingContract.deploy(processContract.target);
    console.log(`OrderingContract deployed at: ${orderingContract.target}`);

    await processContract.setParticipants(0, [participants.cusomter1.publicKey, participants.retailer1.publicKey, participants.manufacturer1.publicKey]);
    

}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
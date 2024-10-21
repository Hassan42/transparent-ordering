const hre = require("hardhat");
const { ethers } = require("hardhat");
const { getParticipants } = require('./helper');


async function main() {
    // Call the function to retrieve participant keys
    const participantKeys = await getParticipants();

    console.log('Participant:', participantKeys);

    // Define the recipient address (this can be a blank address or any valid address)
    const recipientAddress = '0x0000000000000000000000000000000000000000'; // Replace with a valid address if needed
    const amountToSend = ethers.parseEther("0.01"); // Adjust the amount as needed

    // Create an array to hold transaction promises
    const transactionPromises = [];

    // Loop through each participant and send a transaction
    for (const [role, { node, publicKey, privateKey }] of Object.entries(participantKeys)) {
        // Create a wallet instance from the private key
        const wallet = new ethers.Wallet(privateKey, hre.ethers.provider);

        const balance = await hre.ethers.provider.getBalance(wallet.address);
        console.log(`Balance for ${role} (${publicKey}):`, ethers.formatEther(balance), "ETH");

        // Create a transaction object
        const tx = {
            to: recipientAddress,
            value: amountToSend,
            gasLimit: 21000, // Standard gas limit for a simple ETH transfer
        };

        // Send the transaction and push the promise to the array
        const txPromise = wallet.sendTransaction(tx)
            .then(txResponse => {
                console.log(`Transaction sent from ${publicKey} (${role}):`, txResponse.hash);
                return txResponse.wait().then(() => {
                    console.log(`Transaction ${txResponse.hash} mined successfully.`);
                });
            })
            .catch(error => {
                console.error(`Error sending transaction for ${role}:`, error);
            });

        transactionPromises.push(txPromise);
    }

    // Wait for all transactions to complete
    await Promise.all(transactionPromises);
    console.log('All transactions have been processed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
const { expect } = require("chai");
const { ethers } = require("hardhat");

// describe("ProcessContract", function () {
//     let processContract;
//     let accounts;

//     beforeEach(async function () {
//         // Deploy ProcessContract
//         const ProcessContract = await ethers.getContractFactory("ProcessContract");
//         processContract = await ProcessContract.deploy(); 

//         // Get accounts
//         accounts = await ethers.getSigners();
//     });

//     it("should set participants and get their addresses", async function () {
//         await processContract.setParticipantsByTask(0, "PurchaseOrder", accounts[1].address, accounts[2].address);
        
//         const [sender, receiver] = await processContract.getParticipantsByTask(0, "PurchaseOrder");
        
//         expect(sender).to.equal(accounts[1].address);
//         expect(receiver).to.equal(accounts[2].address);
//     });

//     it("should set and get state correctly", async function () {
//         await processContract.setState(0, "PurchaseOrder", 1);
        
//         const state = await processContract.getState(0, "PurchaseOrder");
        
//         expect(state).to.equal(1); // Open state
//     });

//     it("should handle purchase order correctly", async function () {
//         await processContract.setParticipantsByTask(0, "PurchaseOrder", accounts[1].address, accounts[2].address);
//         await processContract.setState(0, "PurchaseOrder", 1); // Open

//         await processContract.connect(accounts[1]).PurchaseOrder(0);
//         const stateAfter = await processContract.getState(0, "PurchaseOrder");
        
//         expect(stateAfter).to.equal(2); // Completed state
//     });
// });
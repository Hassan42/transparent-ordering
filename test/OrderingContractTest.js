// const { expect } = require("chai");
// const { ethers } = require("hardhat");
// const { mine } = require("@nomicfoundation/hardhat-network-helpers");

// describe("OrderingContract", function () {
//     let orderingContract;
//     let processContract;
//     let accounts;

//     beforeEach(async function () {
//         // Deploy ProcessContract first
//         const ProcessContract = await ethers.getContractFactory("ProcessContract");
//         processContract = await ProcessContract.deploy(); // No need to call .deployed()

//         // Deploy OrderingContract with ProcessContract address
//         const OrderingContract = await ethers.getContractFactory("OrderingContract");
//         orderingContract = await OrderingContract.deploy(processContract.target); // No need to call .deployed()

//         // Get accounts
//         accounts = await ethers.getSigners();

//         // Set participants for tasks
//         await processContract.setParticipantsByTask(0, "PurchaseOrder", accounts[0].address, accounts[2].address);
//         await processContract.setParticipantsByTask(1, "PurchaseOrder", accounts[1].address, accounts[2].address);

//         await processContract.setParticipantsByTask(2, "PurchaseOrder", accounts[0].address, accounts[3].address);
//         await processContract.setParticipantsByTask(3, "PurchaseOrder", accounts[1].address, accounts[3].address);
//     });

//     it("should order interactions correctly", async function () {
//         // Accounts for senders and voter
//         const [sender1, sender2, voter] = accounts;
//         // Submit two interactions by different senders
//         await orderingContract.connect(sender1).submitInteraction(0, "PurchaseOrder");
//         await orderingContract.connect(sender2).submitInteraction(1, "PurchaseOrder");

//         await mine(5); // skip two blocks to unlock voting

//         // console.log(await orderingContract.getDomainByIndex(1));

//         // Voter orders the interactions
//         await orderingContract.connect(voter).orderInteraction(1, [0, 1]); // Pass the indices of interactions to reorder
//         // Check if the index block is reset to 0 after voting
//         const indexBlock = await orderingContract.index_block();
//         expect(indexBlock).to.equal(0);
//     });

//     it("should order isolated interactions correctly", async function () {
//         // Accounts for senders and voter
//         const [sender1] = accounts;
//         // Submit two interactions by different senders
//         await orderingContract.connect(sender1).submitInteraction(0, "PurchaseOrder");

//         await mine(5); // skip two blocks to unlock voting

//         // Release isolated interactions
//         await orderingContract.release();

//         // Check if the index block is reset to 0 after voting
//         const indexBlock = await orderingContract.index_block();
//         expect(indexBlock).to.equal(0);
//     });

//     it("should detect conflicts", async function () {
//         // Accounts for senders and voter
//         const [sender1, sender2, sender3, sender4] = accounts;

//         // Submit four interactions by different senders
//         await Promise.all([
//             orderingContract.connect(sender1).submitInteraction(0, "PurchaseOrder"), // customer1 -> store1
//             orderingContract.connect(sender2).submitInteraction(1, "PurchaseOrder"), // customer2 -> store1
//             orderingContract.connect(sender1).submitInteraction(2, "PurchaseOrder"), // customer1 -> store2
//             orderingContract.connect(sender2).submitInteraction(3, "PurchaseOrder"), // customer2 -> store2
//         ]);

//         await mine(5); // Skip two blocks to unlock voting

//         const domain_before_voting = await orderingContract.getDomainByIndex(1);

//         // Check the orderers count
//         const orderersCount = domain_before_voting[2];

//         // Assert that the orderers count is 4
//         expect(orderersCount).to.equal(4);

//         // Voter orders the interactions
//         await orderingContract.connect(sender1).orderInteraction(1, [0, 2]);
//         await orderingContract.connect(sender2).orderInteraction(1, [1, 3]);
//         await orderingContract.connect(sender3).orderInteraction(1, [0, 1]);

//         const domain_after_voting = await orderingContract.getDomainByIndex(1);

//         // Check the voters count
//         const voterCount = domain_after_voting[1];

//         // Assert that the orderers count is 4
//         expect(voterCount).to.equal(3);


//         // Expecting a conflict when sender4 orders interactions that would conflict
//         await expect(orderingContract.connect(sender4).orderInteraction(1, [3, 2])) // Expect a conflict
//             .to.emit(orderingContract, "Conflict"); // Check that Conflict event is emitted 

//     });


//     it("should create two domains", async function () {
//         // Accounts for senders and voter
//         const [sender1, sender2, sender3, sender4] = accounts;

//         // Submit four interactions by different senders
//         await Promise.all([
//             orderingContract.connect(sender1).submitInteraction(0, "PurchaseOrder"), // customer1 -> store1
//             orderingContract.connect(sender2).submitInteraction(3, "PurchaseOrder"), // customer2 -> store2
//         ]);

//         await mine(5); // Skip two blocks to unlock voting

//         const domain_count = await orderingContract.domain_count();

//         // Assert that the orderers count is 4
//         expect(domain_count).to.equal(2);

//         // Release isolated interactions
//         await orderingContract.release();

//         // Check if the index block is reset to 0 after voting
//         const indexBlock = await orderingContract.index_block();
//         expect(indexBlock).to.equal(0);
//     });

// });
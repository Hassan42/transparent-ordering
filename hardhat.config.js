require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-chai-matchers");

/** @type import('hardhat/config').HardhatUserConfig */

// Define a simple task to get the signers
task("accounts", "Prints the list of signers", async (taskArgs, hre) => {
  const signers = await hre.ethers.getSigners();

  for (const signer of signers) {
    console.log(signer.address);
  }
});

module.exports = {
  solidity: "0.8.27",
  defaultNetwork: "goquorum",
  networks: {
    goquorum: {
      url: "http://localhost:8552",
    },
  },
};
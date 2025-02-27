# Transparent Ordering Process Execution

This document provides an overview of how to execute the process defined in `start-process.js` using Hardhat and the GoQuorum network.

## Prerequisites

Ensure that you have the following installed:
- [Node.js](https://nodejs.org/) and npm
- Docker
- GoQuorum modified client (docker pull haccan/quorum-censor:latest)

## Network Configuration

To create a test network, use the Postman endpoints located in `./Postman`. The available endpoints allow you to:

1. **Create a network** – This endpoint sets up a new network by defining participants, including normal nodes and censor nodes with target restrictions.
2. **Configure participants** – Allows creating participants configurations.
3. **Start the network** – Activates the created network.
4. **Stop the network** – Halts the running network.

## Command Overview

After starting the network, run the process by execute the following command:

```sh
EVENT_LOG_PATH={Path to event log} STRATEGY={0,1,2} ROUNDS=500 SETTING={OC,PLAIN} npx hardhat run scripts/start-process.js --network goquorum
```

### Explanation of Command Parameters

- `EVENT_LOG_PATH`: Specifies the path to the event log file.
- `STRATEGY`: Defines the strategy to be used for the process (0: Intermediate, 1: Active, 2: External).
- `ROUNDS`: Sets the number of rounds the process will execute.
- `SETTING`: Defines the setting under which the process runs (OC: Ordering Contract setting, PLAIN: Plain setting).





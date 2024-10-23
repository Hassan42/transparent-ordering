// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IProcessContract.sol";

contract OrderingContract {
    IProcessContract public process;
    address public workflow_address;

    uint public block_interval = 5;
    uint public index_block = 0;
    uint public domain_count = 0;

    struct Interaction {
        uint instance;
        address sender;
        address receiver;
        string task;
        uint block_number;
        uint domain;
    }

    struct Orderer {
        address ordererAddress;
        bool voted;
    }

    struct Domain {
        uint id;
        DomainStatus status;
        mapping(address => Orderer) orderers;
        uint vote_count;
        uint[] ordered_interactions;
        uint orderers_count;
    }

    enum DomainStatus {
        Pending,
        Completed,
        Conflict
    }

    Interaction[] public pending_interactions;
    Domain[] public domains;

    event Conflict(uint indexed domain, uint[2] transactions);

    modifier duringVote() {
        require(
            index_block != 0 && block.number >= index_block + block_interval,
            "Can't vote now."
        );
        _;
    }

    constructor(address processContractAddress) {
        require(processContractAddress != address(0), "Invalid address");
        process = IProcessContract(processContractAddress);
    }

    // Function to submit an interaction for ordering
    function submitInteraction(uint instance, string memory task) external {
        if (index_block == 0) {
            index_block = block.number;
        }

        require(
            block.number < index_block + block_interval,
            "Transactions list is locked."
        );

        (address sender, address receiver) = process.getParticipantsByTask(
            instance,
            task
        );

        pending_interactions.push(
            Interaction({
                instance: instance,
                sender: sender,
                receiver: receiver,
                task: task,
                block_number: block.number,
                domain: 0
            })
        );

        updateDomains();
        updateOrderers();
    }

    // Internal function to update orderers
    function updateOrderers() internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            address sender = pending_interactions[i].sender;
            address receiver = pending_interactions[i].receiver;
            uint domainID = pending_interactions[i].domain;

            // Check for sender and receiver in the rest of the interactions
            checkForOrderer(domainID, sender);
            checkForOrderer(domainID, receiver);
        }
    }

    // Helper function to check and add orderer
    function checkForOrderer(uint domainID, address user) internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            if (
                user == pending_interactions[i].sender ||
                user == pending_interactions[i].receiver
            ) {
                if (!isOrderer(domainID, user)) {
                    domains[domainID].orderers[user] = Orderer(user, false);
                    domains[domainID].orderers_count++;
                }
                break;
            }
        }
    }

    // Helper function to check if a user is an orderer
    function isOrderer(uint domainId, address user) internal view returns (bool) {
        return domains[domainId].orderers[user].ordererAddress == user;
    }

    // Function to order interactions within a domain
    function orderInteraction(uint domainId, uint[] calldata indicesToReorder) external duringVote {
        require(indicesToReorder.length > 1, "Need at least two indices to reorder");

        Domain storage domain = domains[domainId];
        bool[] memory reorderedFlags = new bool[](pending_interactions.length);
        domain.vote_count++;

        uint anchorIndex = 0;
        for (uint i = 0; i < indicesToReorder.length; i++) {
            uint currentIndex = indicesToReorder[i];

            require(currentIndex < pending_interactions.length, "Invalid interaction ID");
            require(!reorderedFlags[currentIndex], "Duplicate interaction ID in the order");
            reorderedFlags[currentIndex] = true;

            if (isConflict(domain, currentIndex, anchorIndex)) {
                domain.status = DomainStatus.Conflict;
                break;
            }

            domain.ordered_interactions.push(currentIndex);
        }

        if (domain.vote_count == domain.orderers_count) {
            domain.status = DomainStatus.Completed;
        }

        if (checkAllDomainsStatus()) {
            // Logic to execute all domains
            resetData();
        }
    }

    // Helper function to check for conflicts
    function isConflict(Domain storage domain, uint currentIndex, uint anchorIndex) internal view returns (bool) {
        for (uint j = 0; j < domain.ordered_interactions.length; j++) {
            if (domain.ordered_interactions[j] == currentIndex) {
                return j < anchorIndex;
            }
        }
        return false;
    }

    // Internal function to update domains for pending interactions
    function updateDomains() internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            Interaction memory current_interaction = pending_interactions[i];
            uint domainId = current_interaction.domain;

            if (domainId == 0) {
                domainId = findOrCreateDomain(i);
                pending_interactions[i].domain = domainId;
            }
        }
    }

    // Helper function to find or create a domain
    function findOrCreateDomain(uint interactionIndex) internal returns (uint) {
        Interaction memory current_interaction = pending_interactions[interactionIndex];
        for (uint j = 0; j < pending_interactions.length; j++) {
            if (interactionIndex != j) {
                Interaction memory next_interaction = pending_interactions[j];
                if (
                    current_interaction.sender == next_interaction.sender ||
                    current_interaction.sender == next_interaction.receiver ||
                    current_interaction.receiver == next_interaction.sender ||
                    current_interaction.receiver == next_interaction.receiver
                ) {
                    return next_interaction.domain;
                }
            }
        }

        domain_count++;
        Domain storage newDomain = domains[domain_count];
        newDomain.id = domain_count;
        newDomain.status = DomainStatus.Pending;
        return domain_count;
    }

    // Function to check if all domains are either completed or in conflict
    function checkAllDomainsStatus() internal view returns (bool) {
        for (uint i = 0; i < domains.length; i++) {
            if (domains[i].status == DomainStatus.Pending) {
                return false;
            }
        }
        return true;
    }

    // Function to release interactions for execution
    function release() external {
        require(
            index_block != 0 &&
            block.number >= index_block + block_interval &&
            domain_count >= 1,
            "Cannot release"
        );

        for (uint i = 0; i < domains.length; i++) {
            require(domains[i].orderers_count == 0, "Not all domains have zero orderers");
        }

        executeInteractions();
    }

    // Internal function to execute interactions and reset contract data
    function executeInteractions() internal {
        resetData();
    }

    // Internal function to reset contract data
    function resetData() internal {
        delete domains;
        delete pending_interactions;
        domain_count = 0;
        index_block = 0;
    }
}

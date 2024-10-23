// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IProcessContract.sol";

contract OrderingContract {
    IProcessContract public process;
    address public workflow_address;

    uint public block_interval = 5;
    uint public index_block = 0;

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
        Orderer[] orderers;
        uint vote_count;
        uint[] ordered_interactions;
    }

    enum DomainStatus {
        Pending,
        Completed,
        Conflict
    }

    Interaction[] public pending_interactions;

    Domain[] public domains;
    uint public domain_count = 0;

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

        update_domains();
        update_orderers();
    }

    function update_orderers() internal {
        // Selecting strategy for selecting orderers
        intermediate_orderer();
    }

    function intermediate_orderer() internal {

        for (uint i = 0; i < pending_interactions.length; i++) {
            address sender = pending_interactions[i].sender;
            address receiver = pending_interactions[i].receiver;
            uint domainID = pending_interactions[i].domain;

            // Check for sender in the rest of the interactions
            for (uint j = 0; j < pending_interactions.length; j++) {
                if (i == j) {
                    continue;
                }

                // Check if the sender matches either the sender or receiver of another interaction
                if (
                    sender == pending_interactions[j].sender ||
                    sender == pending_interactions[j].receiver
                ) {
                    if (!isOrderer(domainID, sender)) {
                        getDomainById(domainID).orderers.push(
                            Orderer(sender, false)
                        );
                    }
                    break; // No need to check further once sender is added
                }
            }

            // Check for receiver in the rest of the interactions
            for (uint j = 0; j < pending_interactions.length; j++) {
                if (i == j) {
                    continue;
                }

                // Check if the receiver matches either the sender or receiver of another interaction
                if (
                    receiver == pending_interactions[j].sender ||
                    receiver == pending_interactions[j].receiver
                ) {
                    if (!isOrderer(domainID, receiver)) {
                        getDomainById(domainID).orderers.push(
                            Orderer(receiver, false)
                        );
                    }
                    break; // No need to check further once receiver is added
                }
            }
        }
    }

    function isOrderer(
        uint domainId,
        address user
    ) internal view returns (bool) {
        // Retrieve the domain by ID using the getDomainById function
        Domain memory domain = getDomainById(domainId);

        // Loop through the orderers in the domain to check if the address is present
        for (uint i = 0; i < domain.orderers.length; i++) {
            if (domain.orderers[i].ordererAddress == user) {
                return true; // Return true if the address is found in the list of orderers
            }
        }

        return false; // Return false if the address is not in the orderers list
    }

    // Check if all domains are ready to be executed
    function checkAllDomainsStatus() internal returns (bool) {
        bool allCompletedOrConflict = true;

        for (uint i = 0; i < domains.length; i++) {
            if (
                domains[i].status != DomainStatus.Completed &&
                domains[i].status != DomainStatus.Conflict
            ) {
                allCompletedOrConflict = false;
                break;
            }
        }

        return allCompletedOrConflict;
    }

    function orderInteraction(
        uint domainId,
        uint[] calldata indicesToReorder
    ) external duringVote {
        require(
            indicesToReorder.length > 1,
            "Need at least two indices to reorder"
        );

        // Retrieve the domain by ID
        Domain storage domain = getDomainById(domainId);

        // Validate all provided indices are within bounds and not duplicated
        bool[] memory reorderedFlags = new bool[](pending_interactions.length);
        for (uint i = 0; i < indicesToReorder.length; i++) {
            uint index = indicesToReorder[i];
            require(
                index < pending_interactions.length,
                "Invalid interaction ID"
            );
            require(
                !reorderedFlags[index],
                "Duplicate interaction ID in the order"
            );
            reorderedFlags[index] = true;
        }

        domain.vote_count++;

        // Check for conflicts and store interactions in ordered_interactions of the domain
        uint anchorIndex = 0;
        uint existingIndex = 0;

        for (uint i = 0; i < indicesToReorder.length; i++) {
            uint currentIndex = indicesToReorder[i];

            // Check if the interaction exists in domain's ordered_interactions
            bool existsInOrdered = false;
            for (uint j = 0; j < domain.ordered_interactions.length; j++) {
                if (domain.ordered_interactions[j] == currentIndex) {
                    existsInOrdered = true;
                    existingIndex = j;
                    break;
                }
            }

            // If interaction is found, check for conflicts
            if (existsInOrdered) {
                if (existingIndex >= anchorIndex) {
                    anchorIndex = existingIndex;
                } else {
                    // Conflict detected between ordered interactions
                    Interaction
                        memory conflictingInteraction1 = pending_interactions[
                            domain.ordered_interactions[anchorIndex]
                        ];
                    Interaction
                        memory conflictingInteraction2 = pending_interactions[
                            domain.ordered_interactions[existingIndex]
                        ];

                    // Flag conflicting domain
                    domain.status = DomainStatus.Conflict;

                    // emit Conflict(
                    //     domain.id,
                    //     [conflictingInteraction1.id, conflictingInteraction2.id]
                    // );

                    break;
                }
            } else {
                // Add interaction to ordered_interactions if it doesn't exist
                domain.ordered_interactions.push(currentIndex);
            }
        }

        if (domain.vote_count == domain.orderers.length) {
            domain.status = DomainStatus.Completed;
        }

        bool domainStatus = checkAllDomainsStatus();

        if (domainStatus) {}
    }

    function executeInteractions() internal {
        reset_data();
    }

    // Function to generate domains based on common senders or receivers
    function update_domains() internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            Interaction memory current_interaction = pending_interactions[i];
            uint domainId = current_interaction.domain;

            if (domainId == 0) {
                bool matched = false;

                for (uint j = 0; j < pending_interactions.length; j++) {
                    if (i != j) {
                        Interaction
                            memory next_interaction = pending_interactions[j];

                        address current_sender = current_interaction.sender;
                        address current_receiver = current_interaction.receiver;

                        address next_sender = next_interaction.sender;
                        address next_receiver = next_interaction.receiver;

                        // Check if the sender or receiver matches for the interactions
                        if (
                            current_sender == next_sender ||
                            current_sender == next_receiver ||
                            current_receiver == next_sender ||
                            current_receiver == next_receiver
                        ) {
                            pending_interactions[i].domain = domainId; // Assign the same domain
                            matched = true;
                            break;
                        }
                    }
                }

                // If no match is found, create a new domain
                if (!matched) {
                    Domain memory newDomain;
                    pending_interactions[i].domain = ++domain_count;
                    newDomain.id = domain_count;
                    newDomain.status = DomainStatus.Pending;
                    domains.push(newDomain);
                }
            }
        }
    }

    function getDomainById(
        uint domainId
    ) internal view returns (Domain memory) {
        for (uint i = 0; i < domains.length; i++) {
            if (domains[i].id == domainId) {
                return domains[i]; // Return the domain with the matching ID
            }
        }

        revert("Domain with the given ID not found");
    }

    function release() external {
        // Check if the index block is set and if the block interval has passed
        require(
            index_block != 0 &&
                block.number >= index_block + block_interval &&
                domain_count >= 1,
            "Cannot Release"
        );

        // Check if all domains have zero orderers
        for (uint i = 0; i < domains.length; i++) {
            require(
                domains[i].orderers.length == 0,
                "Not all domains have zero orderers"
            );
        }

        // If the check passes, execute interactions
        executeInteractions();
    }

    function reset_data() internal {
        delete domains;
        delete pending_interactions;

        domain_count = 0;
        index_block = 0;
    }
}

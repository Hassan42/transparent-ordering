// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IProcessContract.sol";

contract OrderingContract {
    IProcessContract public process;

    uint public block_interval = 5;
    uint public index_block = 0;
    uint public domain_count = 0; // domain 0 is reserved

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
        mapping(uint => Orderer) orderers;
        uint vote_count;
        uint[] ordered_interactions;
        uint orderers_count;
        mapping(address => uint[]) ordererToPendingInteractions; // TODO: move it to orderer
    }

    enum DomainStatus {
        Pending,
        Completed,
        Conflict
    }

    Interaction[] public pending_interactions;

    // Mapping to store domains instead of an array, index 0 is preserved for domainless interactions
    mapping(uint => Domain) public domains;

    event Conflict(uint indexed domain);
    event InteractionPoolOpen();
    event OrdererAdded(uint domainId, uint ordererId, address ordererAddress);

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

    // Function to retrieve a domain by index (For testing)
    function getDomainByIndex(
        uint domainId
    )
        external
        view
        returns (
            uint id,
            DomainStatus status,
            address[] memory orderers, // returning orderers as an array
            uint voteCount,
            uint[] memory orderedInteractions,
            uint orderersCount
        )
    {
        Domain storage domain = domains[domainId];

        // Create an array to store orderer addresses from the mapping
        address[] memory ordererAddresses = new address[](
            domain.orderers_count
        );
        uint counter = 0;

        for (uint i = 0; i < domain.orderers_count; i++) {
            address ordererAddress = domain.orderers[i].ordererAddress;
            ordererAddresses[counter] = ordererAddress;
            counter++;
        }

        return (
            domain.id,
            domain.status,
            ordererAddresses,
            domain.vote_count,
            domain.ordered_interactions,
            domain.orderers_count
        );
    }

    function getPendingInteractions()
        external
        view
        returns (Interaction[] memory)
    {
        // Return the pending interactions for a specific domain
        return pending_interactions;
    }

    function getPendingInteractionsForOrderer(
        uint domainId,
        address orderer
    ) external view returns (uint[] memory) {
        // Retrieve the list of pending interaction IDs for the given orderer
        uint[] memory pendingInteractionIds = domains[domainId]
            .ordererToPendingInteractions[orderer];

        return pendingInteractionIds;
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

    function addOrderer(uint _domainId, address _ordererAddress) public {
        Domain storage domain = domains[_domainId];

        // Use orderers_count as the new ordererId and increment it
        uint ordererId = domain.orderers_count;

        // Add the orderer to the domain using the incremented ordererId
        domain.orderers[ordererId] = Orderer({
            ordererAddress: _ordererAddress,
            voted: false
        });

        // Increment the orderers_count to prepare for the next orderer
        domain.orderers_count++;

        // Emit event for added orderer
        emit OrdererAdded(_domainId, ordererId, _ordererAddress);
    }

    // Internal function to update orderers (Intermediate orderer)
    function updateOrderers() internal {
        for (uint i = 0; i < pending_interactions.length; i++) {
            address sender = pending_interactions[i].sender;
            address receiver = pending_interactions[i].receiver;
            uint domainID = pending_interactions[i].domain;

            for (uint j = 0; j < pending_interactions.length; j++) {
                // Ensure we are not comparing the interaction against itself
                if (i != j) {
                    // Check if the sender or receiver is part of the other interactions
                    if (
                        sender == pending_interactions[j].sender ||
                        sender == pending_interactions[j].receiver
                    ) {
                        // Add sender as an orderer if not already present
                        if (!isOrderer(domainID, sender)) {
                            addOrderer(domainID, sender);
                        }
                        // Map interaction index to orderer
                        domains[domainID]
                            .ordererToPendingInteractions[sender]
                            .push(i);
                    }

                    if (
                        receiver == pending_interactions[j].sender ||
                        receiver == pending_interactions[j].receiver
                    ) {
                        // Add receiver as an orderer if not already present
                        if (!isOrderer(domainID, receiver)) {
                            addOrderer(domainID, receiver);
                        }
                        // Map interaction index to orderer
                        domains[domainID]
                            .ordererToPendingInteractions[receiver]
                            .push(i);
                    }
                }
            }
        }
    }

    // Helper function to check if a pariticpant is an orderer
    function isOrderer(
        uint domainId,
        address pariticpant
    ) internal view returns (bool) {
        Domain storage domain = domains[domainId];

        // Iterate over all orderers by their ID
        for (uint i = 0; i < domain.orderers_count; i++) {
            if (domain.orderers[i].ordererAddress == pariticpant) {
                return true;
            }
        }

        return false; // Pariticpant is not an orderer in this domain
    }

    // Function to order interactions within a domain
    function orderInteraction(
        uint domainId,
        uint[] calldata indicesToReorder
    ) external duringVote {
        require(
            indicesToReorder.length > 1,
            "Need at least two indices to reorder"
        );

        require(isOrderer(domainId, msg.sender));

        Domain storage domain = domains[domainId];
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
                    emit Conflict(domainId);
                    break;
                }
            } else {
                // Add interaction to ordered_interactions if it doesn't exist
                domain.ordered_interactions.push(currentIndex);
            }
        }

        if (domain.vote_count == domain.orderers_count) {
            domain.status = DomainStatus.Completed;
        }

        if (checkAllDomainsStatus()) {
            executeInteractions();
        }
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
        Interaction memory current_interaction = pending_interactions[
            interactionIndex
        ];
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
        for (uint i = 1; i <= domain_count; i++) {
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

        for (uint i = 1; i <= domain_count; i++) {
            require(
                domains[i].orderers_count == 0,
                "Not all domains have zero orderers"
            );
        }

        executeInteractions();
    }

    // Internal function to execute interactions and reset contract data
    function executeInteractions() internal {
        for (uint i = 1; i <= domain_count; i++) {
            executeDomain(i);
        }
        resetData();
        emit InteractionPoolOpen();
    }

    // Internal function to execute all interactions within a specific domain
    function executeDomain(uint domainId) internal {
        for (
            uint j = 0;
            j < domains[domainId].ordered_interactions.length;
            j++
        ) {
            uint instanceId = pending_interactions[j].instance;
            string memory taskName = pending_interactions[j].task;

            // We use call method to avoid cascading a revert case (we don't want the ordering contract to be interrupted by the process contract)
            (bool success, bytes memory data) = address(process).call(
                abi.encodeWithSignature("executeTask", instanceId, taskName)
            );
        }
    }

    // Internal function to reset contract data
    function resetData() internal {
        for (uint i = 1; i <= domain_count; i++) {
            delete domains[i];
        }
        delete pending_interactions;
        domain_count = 0;
        index_block = 0;
    }

    function canVote() public view returns (bool) {
        return index_block != 0 && block.number >= index_block + block_interval;
    }
}

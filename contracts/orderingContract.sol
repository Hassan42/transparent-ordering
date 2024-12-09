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
    }

    enum DomainStatus {
        Pending,
        Completed,
        Conflict,
        Merged,
        Executed
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
        // Create a temporary array to store indices of matching interactions
        uint[] memory tempIndices = new uint[](pending_interactions.length);

        uint count = 0;

        for (uint i = 0; i < pending_interactions.length; i++) {
            uint interactionDomain = pending_interactions[i].domain;

            // Check if the domain matches and if the orderer matches
            if (interactionDomain == domainId && matchParticipant(orderer, i)) {
                tempIndices[count] = i; // Store the index of the matching interaction
                count++;
            }
        }

        // Create an array with the exact size for the matching indices
        uint[] memory matchingIndices = new uint[](count);

        for (uint j = 0; j < count; j++) {
            matchingIndices[j] = tempIndices[j];
        }

        return matchingIndices;
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
        // updateOrderers();
        updateOrderersAll();
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

    function updateOrderersExternal() internal {
        // Update the external list, if empty fallback to all orderers or intermediate. 
           
    }

    function updateOrderersAll() internal {
        // Get the last interaction in the list
        uint i = pending_interactions.length - 1;
        address sender = pending_interactions[i].sender;
        address receiver = pending_interactions[i].receiver;
        uint domainID = pending_interactions[i].domain;

        // Add sender to the orderer list if not already added
        if (!isOrderer(domainID, sender)) {
            addOrderer(domainID, sender);
        }

        // Add receiver to the orderer list if not already added
        if (!isOrderer(domainID, receiver)) {
            addOrderer(domainID, receiver);
        }
    }

    function updateOrderers() internal {
        // Get the last interaction in the list
        uint i = pending_interactions.length - 1;
        address sender = pending_interactions[i].sender;
        address receiver = pending_interactions[i].receiver;
        uint domainID = pending_interactions[i].domain;

        for (uint j = 0; j < pending_interactions.length; j++) {
            if (i != j) {
                // Check if sender matches any previous interaction
                if (matchParticipant(sender, j)) {
                    if (!isOrderer(domainID, sender)) {
                        addOrderer(domainID, sender);
                    }
                    continue;
                }

                // Check if receiver matches any previous interaction
                if (matchParticipant(receiver, j)) {
                    if (!isOrderer(domainID, receiver)) {
                        addOrderer(domainID, receiver);
                    }
                    continue;
                }
            }
        }
    }

    // Helper function to check if the participant matches another interaction's sender or receiver
    function matchParticipant(
        address participant,
        uint interactionIndex
    ) internal view returns (bool) {
        return (participant == pending_interactions[interactionIndex].sender ||
            participant == pending_interactions[interactionIndex].receiver);
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

        // require(isOrderer(domainId, msg.sender), "Sender is not an orderer"); (dev)

        require(
            domains[domainId].status == DomainStatus.Pending,
            "Domain is not pending"
        );

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

            // check if the interaction are within the list of the orderer (dev)
            // require(
            //     matchParticipant(msg.sender, index),
            //     "Not allowed to order this interaction"
            // );

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
                    domain.status = DomainStatus.Conflict;
                    emit Conflict(domainId);
                    break;
                }
            } else {
                // Add interaction to ordered_interactions if it doesn't exist
                domain.ordered_interactions.push(currentIndex);
            }
        }

        // Mark as complete all votes are included and not in conflict
        if (
            domain.vote_count == domain.orderers_count &&
            domain.status != DomainStatus.Conflict
        ) {
            domain.status = DomainStatus.Completed;
        }

        if (checkAllDomainsStatus()) {
            executeInteractions();
        }
    }

    // Internal function to update domains for the last pending interaction
    function updateDomains() internal {
        if (pending_interactions.length == 0) {
            return; // Exit if there are no interactions
        }

        uint lastInteractionIndex = pending_interactions.length - 1;
        Interaction memory currentInteraction = pending_interactions[
            lastInteractionIndex
        ];
        uint domainId = currentInteraction.domain;

        if (domainId == 0) {
            domainId = findAndAssignDomain(lastInteractionIndex);
            pending_interactions[lastInteractionIndex].domain = domainId;
        }
    }

    /**
     *      Finds an appropriate domain for a given interaction. If no suitable
     *      domain is found, a new one is created only if there are matched interactions.
     *      If no matches are found, returns 0 to indicate no domain assignment.
     * @param interactionIndex Index of the interaction within `pending_interactions`
     *                         for which we are finding or creating a domain.
     * @return uint The domain ID assigned to the interaction, or 0 if no domain was isolated.
     */
    function findAndAssignDomain(
        uint interactionIndex
    ) internal returns (uint) {
        Interaction memory currentInteraction = pending_interactions[
            interactionIndex
        ];
        uint[] memory matchedIndexes = new uint[](pending_interactions.length);
        uint matchCount = 0;
        uint primaryDomainId = 0;
        uint[] memory relatedDomains = new uint[](pending_interactions.length);
        uint relatedDomainCount = 0;

        // Iterate over previous interactions to find matches with the current one.
        // Matches are based on shared sender or receiver addresses.
        for (uint j = 0; j < interactionIndex; j++) {
            Interaction memory otherInteraction = pending_interactions[j];

            bool isMatch = (currentInteraction.sender ==
                otherInteraction.sender ||
                currentInteraction.sender == otherInteraction.receiver ||
                currentInteraction.receiver == otherInteraction.sender ||
                currentInteraction.receiver == otherInteraction.receiver);

            if (isMatch) {
                uint otherDomainId = otherInteraction.domain;

                if (otherDomainId != 0) {
                    // Check if the other interaction has a domain and track it if not already tracked.
                    bool isDomainTracked = false;
                    for (uint k = 0; k < relatedDomainCount; k++) {
                        if (relatedDomains[k] == otherDomainId) {
                            isDomainTracked = true;
                            break;
                        }
                    }
                    if (!isDomainTracked) {
                        // Add this domain ID to `relatedDomains` to track domains that need merging.
                        relatedDomains[relatedDomainCount] = otherDomainId;
                        relatedDomainCount++;
                    }
                } else {
                    // If the other interaction doesn't have a domain, add it to matched indexes.
                    matchedIndexes[matchCount] = j;
                    matchCount++;
                }
            }
        }

        // If there are related domains, merge them into a single primary domain.
        if (relatedDomainCount > 0) {
            primaryDomainId = relatedDomains[0];
            Domain storage primaryDomain = domains[primaryDomainId];

            // Merge all additional related domains into the primary domain.
            for (uint d = 1; d < relatedDomainCount; d++) {
                uint domainIdToMerge = relatedDomains[d];
                Domain storage domainToMerge = domains[domainIdToMerge];

                // Aggregate the vote count and orderers count.
                primaryDomain.vote_count += domainToMerge.vote_count;
                primaryDomain.orderers_count += domainToMerge.orderers_count;

                // Transfer orderers from the domain being merged to the primary domain.
                for (
                    uint ordererId = 0;
                    ordererId < domainToMerge.orderers_count;
                    ordererId++
                ) {
                    primaryDomain.orderers[
                        primaryDomain.orderers_count++
                    ] = domainToMerge.orderers[ordererId];
                }

                // Mark the merged domain as "Merged".
                domainToMerge.status = DomainStatus.Merged;
            }

            // Assign the primary domain ID to the current interaction and all matched interactions.
            pending_interactions[interactionIndex].domain = primaryDomainId;
            for (uint k = 0; k < matchCount; k++) {
                pending_interactions[matchedIndexes[k]]
                    .domain = primaryDomainId;
            }

            return primaryDomainId;
        }

        // Only create a new domain if there are matched interactions.
        if (matchCount > 0) {
            domain_count++;
            Domain storage newDomain = domains[domain_count];
            newDomain.id = domain_count;
            newDomain.status = DomainStatus.Pending;

            // Assign the new domain ID to all matched interactions and the current interaction.
            for (uint k = 0; k < matchCount; k++) {
                pending_interactions[matchedIndexes[k]].domain = domain_count;
            }
            return domain_count;
        }

        return 0; // Isolated interaction until this moment
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
                domain_count == 0,
            "Cannot release"
        );

        for (uint i = 0; i < pending_interactions.length; i++) {
            require(pending_interactions[i].domain == 0);
            uint instanceId = pending_interactions[i].instance;
            string memory taskName = pending_interactions[i].task;
            (bool success, bytes memory data) = address(process).call(
                abi.encodeWithSignature("executeTask", instanceId, taskName)
            );
        }
        resetData();
        emit InteractionPoolOpen();
    }

    // Internal function to execute interactions and reset contract data
    function executeInteractions() internal {
        for (uint i = 1; i <= domain_count; i++) {
            if (
                domains[i].status == DomainStatus.Conflict ||
                domains[i].status == DomainStatus.Executed
            ) {
                continue;
            }
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
                abi.encodeWithSignature(
                    "executeTask(uint256,string)",
                    instanceId,
                    taskName
                )
            );
        }

        domains[domainId].status = DomainStatus.Executed;
    }

    // Internal function to reset contract data
    function resetData() internal {
        delete pending_interactions;
        index_block = 0;
    }

    function canVote() public view returns (bool) {
        return index_block != 0 && block.number >= index_block + block_interval;
    }
}

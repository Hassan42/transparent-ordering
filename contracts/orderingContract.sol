// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IProcessContract.sol";
import "hardhat/console.sol";

/**
 * @title OrderingContract
 * @dev This contract manages ordering and execution of interactions, allowing conflict resolution
 *      and collaboration among domains and epochs.
 */
contract OrderingContract {
    // Contract Variables
    IProcessContract public process;
    uint public block_interval = 5; // Blocks for voting interval
    uint public index_block = 0; // Starting block for the epoch
    uint public domain_count = 0; // Counter for domains, domain 0 is reserved

    // Structures
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

    struct ExternalOrderer {
        address ordererAddress;
        bool valid;
        bool voted;
    }

    struct Epoch {
        uint id;
        mapping(uint => ExternalOrderer) externalOrderers;
        uint[] ordered_interactions;
        uint vote_count;
        uint externalOrderersCount;
        uint validOrderersCount;
        EpochStatus status;
    }

    // Enums
    enum DomainStatus {
        Pending,
        Completed,
        Conflict,
        Merged,
        Executed
    }

    enum EpochStatus {
        Pending,
        Completed,
        Conflict,
        Executed
    }

    // State Variables
    Interaction[] public pending_interactions;
    mapping(uint => Domain) public domains;
    mapping(uint => Epoch) public epochs;

    // Events
    event Conflict(uint indexed domain);
    event InteractionPoolOpen();
    event OrdererAdded(uint domainId, uint ordererId, address ordererAddress);

    // ===================================
    //          Constructor & Modifier
    // ===================================

    /**
     * @dev Constructor to initialize the process contract.
     * @param processContractAddress The address of the process contract.
     */
    constructor(address processContractAddress) {
        require(processContractAddress != address(0), "Invalid address");
        process = IProcessContract(processContractAddress);
    }

    /**
     * @dev Modifier to ensure actions happen during the voting period.
     */
    modifier duringVote() {
        require(
            index_block != 0 && block.number >= index_block + block_interval,
            "Can't vote now."
        );
        _;
    }

    // ===================================
    //              Getters
    // ===================================

    /**
     * @notice Retrieve details of a specific domain.
     * @param domainId The ID of the domain to fetch.
     */
    function getDomainByIndex(
        uint domainId
    )
        external
        view
        returns (
            uint id,
            DomainStatus status,
            address[] memory orderers,
            uint voteCount,
            uint[] memory orderedInteractions,
            uint orderersCount
        )
    {
        Domain storage domain = domains[domainId];

        address[] memory ordererAddresses = new address[](
            domain.orderers_count
        );

        for (uint i = 0; i < domain.orderers_count; i++) {
            ordererAddresses[i] = domain.orderers[i].ordererAddress;
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

    /**
     * @notice Get all pending interaction IDs.
     * @return Array of interaction IDs.
     */
    function getPendingInteractions() external view returns (uint[] memory) {
        uint[] memory interactionIds = new uint[](pending_interactions.length);
        for (uint i = 0; i < pending_interactions.length; i++) {
            interactionIds[i] = i;
        }
        return interactionIds;
    }

    /**
     * @notice Fetch details of all pending interactions.
     */
    function getPendingInteractionsStruct()
        external
        view
        returns (Interaction[] memory)
    {
        return pending_interactions;
    }

    /**
     * @notice Get interactions for a specific orderer within a domain.
     */
    function getPendingInteractionsForOrderer(
        uint domainId,
        address orderer
    ) external view returns (uint[] memory) {
        uint[] memory tempIndices = new uint[](pending_interactions.length);
        uint count = 0;

        for (uint i = 0; i < pending_interactions.length; i++) {
            if (
                pending_interactions[i].domain == domainId &&
                matchParticipant(orderer, i)
            ) {
                tempIndices[count++] = i;
            }
        }

        uint[] memory matchingIndices = new uint[](count);
        for (uint j = 0; j < count; j++) {
            matchingIndices[j] = tempIndices[j];
        }

        return matchingIndices;
    }

    /**
     * @notice Get the count of valid external orderers in an epoch.
     */
    function getEpochextErnalOrderersCount(
        uint epochId
    ) public view returns (uint) {
        return epochs[epochId].validOrderersCount;
    }

    /**
     * @notice Retrieve all external orderers for a given epoch.
     */
    function getExternalOrderersForEpoch(
        uint epochId
    ) public view returns (ExternalOrderer[] memory) {
        Epoch storage epoch = epochs[epochId];
        ExternalOrderer[] memory orderers = new ExternalOrderer[](
            epoch.externalOrderersCount
        );

        for (uint i = 0; i < epoch.externalOrderersCount; i++) {
            orderers[i] = epoch.externalOrderers[i];
        }

        return orderers;
    }

    /**
     * @notice Check if voting is currently allowed.
     */
    function canVote() public view returns (bool) {
        return index_block != 0 && block.number >= index_block + block_interval;
    }

    // ===================================
    //         Orderer Management
    // ===================================

    /**
     * @notice Add an orderer to a specific domain.
     */
    function addOrderer(uint domainId, address ordererAddress) public {
        Domain storage domain = domains[domainId];
        uint ordererId = domain.orderers_count++;

        domain.orderers[ordererId] = Orderer({
            ordererAddress: ordererAddress,
            voted: false
        });

        emit OrdererAdded(domainId, ordererId, ordererAddress);
    }

    // ===================================
    //         Orderer Updates
    // ===================================

    /**
     * @notice Update external orderers. If the external list is empty, populate it from all participants.
     */
    function updateOrderersExternal() internal {
        // If we have no external orderers yet, populate them. (TODO:Should be done in the initialization phase)
        if (epochs[index_block].externalOrderersCount == 0) {
            address[] memory allParticipants = process.getAllParticipants();
            for (uint k = 0; k < allParticipants.length; k++) {
                // If already participant skip
                if (isOrdererExternal(index_block, allParticipants[k])) {
                    continue;
                }
                epochs[index_block].externalOrderers[
                    epochs[index_block].externalOrderersCount
                ] = ExternalOrderer({
                    ordererAddress: allParticipants[k],
                    voted: false,
                    valid: true
                });
                epochs[index_block].externalOrderersCount++;
                epochs[index_block].validOrderersCount++;
            }
        }

        uint currentExternalOrderersCount = epochs[index_block]
            .externalOrderersCount;

        require(
            epochs[index_block].externalOrderersCount != 0,
            "External Orderers should not be empty"
        );

        // Get the last interaction in the list
        uint i = pending_interactions.length - 1;
        for (uint k = 0; k < currentExternalOrderersCount; k++) {
            if (
                matchParticipant(
                    epochs[index_block].externalOrderers[k].ordererAddress,
                    i
                ) && epochs[index_block].externalOrderers[k].valid == true
            ) {
                epochs[index_block].externalOrderers[k].valid = false;
                epochs[index_block].validOrderersCount--;
            }
        }
    }

    /**
     * @notice Update all orderers based on interactions.
     * Loops through all pending interactions since domains are not fully realized yet.
     */
    function updateOrderersAll() internal {
        uint interactionsCount = pending_interactions.length;

        //It is necessary to loop over the interactions every time, as the domains are not fully realized yet.
        for (uint i = 0; i < interactionsCount; i++) {
            Interaction memory interaction = pending_interactions[i];
            address sender = interaction.sender;
            address receiver = interaction.receiver;
            uint domainID = interaction.domain;

            // Add sender to the orderer list if not already added
            if (!isOrderer(domainID, sender)) {
                addOrderer(domainID, sender);
            }

            // Add receiver to the orderer list if not already added
            if (!isOrderer(domainID, receiver)) {
                addOrderer(domainID, receiver);
            }
        }
    }

    /**
     * @notice Update orderers for the most recent interaction.
     */
    function updateOrderersIntermediate() internal {
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

    // ===================================
    //        Helper Functions
    // ===================================

    /**
     * @notice Check if a participant matches the sender or receiver of a specific interaction.
     */
    function matchParticipant(
        address participant,
        uint interactionIndex
    ) internal view returns (bool) {
        return (participant == pending_interactions[interactionIndex].sender ||
            participant == pending_interactions[interactionIndex].receiver);
    }

    /**
     * @notice Check if a participant is already an orderer in a domain.
     */
    function isOrderer(
        uint domainId,
        address participant
    ) internal view returns (bool) {
        Domain storage domain = domains[domainId];
        for (uint i = 0; i < domain.orderers_count; i++) {
            if (domain.orderers[i].ordererAddress == participant) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Check if a participant is already an external orderer in an epoch.
     */
    function isOrdererExternal(
        uint epochId,
        address participant
    ) internal view returns (bool) {
        Epoch storage epoch = epochs[epochId];
        for (uint i = 0; i < epoch.externalOrderersCount; i++) {
            if (epoch.externalOrderers[i].ordererAddress == participant) {
                return true;
            }
        }
        return false;
    }

    // ===================================
    //        Interaction Management
    // ===================================

    /**
     * @notice Submit a new interaction to the system.
     * Assigns it to a domain or epoch and updates orderers accordingly.
     */
    function submitInteraction(uint instance, string memory task) external {
        if (index_block == 0) {
            index_block = block.number;
            Epoch storage newEpoch = epochs[index_block];
            newEpoch.id = index_block;
            newEpoch.externalOrderersCount = 0;
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
        updateOrderersAll(); // Fallback Strategy: updateOrderersAll || updateOrderersIntermediate
        updateOrderersExternal(); // External Strategy
    }

    /**
     * @notice Allows orderers to vote on the order of interactions within a domain.
     * @param domainId The ID of the domain where the interactions are being ordered.
     * @param indicesToReorder An array of interaction indices to reorder within the domain.
     */
    function orderInteraction(
        uint domainId,
        uint[] calldata indicesToReorder
    ) external duringVote {
        require(
            indicesToReorder.length > 0,
            "Need at least one index to reorder"
        );

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

            if (existsInOrdered) {
                if (existingIndex >= anchorIndex) {
                    anchorIndex = existingIndex;
                } else {
                    domain.status = DomainStatus.Conflict;
                    emit Conflict(domainId);
                    break;
                }
            } else {
                domain.ordered_interactions.push(currentIndex);
            }
        }

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

    /**
     * @notice Allows external orderers to vote on the order of interactions in an epoch.
     * @param indicesToReorder An array of interaction indices to reorder within the epoch.
     */
    function orderInteractionExternal(
        uint[] calldata indicesToReorder
    ) external duringVote {
        require(
            indicesToReorder.length > 0,
            "Need at least two indices to reorder"
        );

        Epoch storage epoch = epochs[index_block];
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

        epoch.vote_count++;

        uint anchorIndex = 0;
        uint existingIndex = 0;

        for (uint i = 0; i < indicesToReorder.length; i++) {
            uint currentIndex = indicesToReorder[i];

            bool existsInOrdered = false;
            for (uint j = 0; j < epoch.ordered_interactions.length; j++) {
                if (epoch.ordered_interactions[j] == currentIndex) {
                    existsInOrdered = true;
                    existingIndex = j;
                    break;
                }
            }

            if (existsInOrdered) {
                if (existingIndex >= anchorIndex) {
                    anchorIndex = existingIndex;
                } else {
                    epoch.status = EpochStatus.Conflict;
                    emit Conflict(index_block);
                    break;
                }
            } else {
                epoch.ordered_interactions.push(currentIndex);
            }
        }

        if (
            epoch.vote_count == epoch.validOrderersCount &&
            epoch.status != EpochStatus.Conflict
        ) {
            epoch.status = EpochStatus.Completed;
            executeInteractionsExternal();
        }

        else if (epoch.status == EpochStatus.Conflict){
            // If conflict exists in epoch we reset 
            resetData();
        }
    }

    // ===================================
    //         Domain Management
    // ===================================

    /**
     * @notice Assign or find a domain for the last interaction.
     */
    function updateDomains() internal {
        if (pending_interactions.length == 0) {
            return;
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
     * @notice Find or create a domain for a given interaction.
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
                    bool isDomainTracked = false;
                    for (uint k = 0; k < relatedDomainCount; k++) {
                        if (relatedDomains[k] == otherDomainId) {
                            isDomainTracked = true;
                            break;
                        }
                    }
                    if (!isDomainTracked) {
                        relatedDomains[relatedDomainCount++] = otherDomainId;
                    }
                } else {
                    matchedIndexes[matchCount++] = j;
                }
            }
        }

        if (relatedDomainCount > 0) {
            primaryDomainId = relatedDomains[0];
            Domain storage primaryDomain = domains[primaryDomainId];

            for (uint d = 1; d < relatedDomainCount; d++) {
                uint domainIdToMerge = relatedDomains[d];
                Domain storage domainToMerge = domains[domainIdToMerge];

                primaryDomain.vote_count += domainToMerge.vote_count;
                primaryDomain.orderers_count += domainToMerge.orderers_count;

                for (
                    uint ordererId = 0;
                    ordererId < domainToMerge.orderers_count;
                    ordererId++
                ) {
                    primaryDomain.orderers[
                        primaryDomain.orderers_count++
                    ] = domainToMerge.orderers[ordererId];
                }

                domainToMerge.status = DomainStatus.Merged;
            }

            pending_interactions[interactionIndex].domain = primaryDomainId;
            for (uint k = 0; k < matchCount; k++) {
                pending_interactions[matchedIndexes[k]]
                    .domain = primaryDomainId;
            }

            return primaryDomainId;
        }

        if (matchCount > 0) {
            domain_count++;
            Domain storage newDomain = domains[domain_count];
            newDomain.id = domain_count;
            newDomain.status = DomainStatus.Pending;

            for (uint k = 0; k < matchCount; k++) {
                pending_interactions[matchedIndexes[k]].domain = domain_count;
            }
            return domain_count;
        }

        return 0;
    }

    /**
     * @notice Checks if all domains have either been completed or marked as conflicted.
     * @return bool True if all domains are finalized, false otherwise.
     */
    function checkAllDomainsStatus() internal view returns (bool) {
        for (uint i = 1; i <= domain_count; i++) {
            if (domains[i].status == DomainStatus.Pending) {
                return false;
            }
        }
        return true;
    }

    // ===================================
    //       Execution & Reset
    // ===================================

    /**
     * @notice Executes all finalized interactions within domains.
     */
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

    /**
     * @notice Executes all finalized interactions in the current epoch.
     */
    function executeInteractionsExternal() internal {
        require(epochs[index_block].status == EpochStatus.Completed);

        for (
            uint j = 0;
            j < epochs[index_block].ordered_interactions.length;
            j++
        ) {
            uint instanceId = pending_interactions[j].instance;
            string memory taskName = pending_interactions[j].task;

            // Using call method to avoid cascading reverts
            (bool success, bytes memory data) = address(process).call(
                abi.encodeWithSignature(
                    "executeTask(uint256,string)",
                    instanceId,
                    taskName
                )
            );
        }

        for (uint i = 1; i <= domain_count; i++) {
            if (
                domains[i].status == DomainStatus.Conflict ||
                domains[i].status == DomainStatus.Executed
            ) {
                continue;
            }
            domains[i].status = DomainStatus.Executed;
        }

        epochs[index_block].status = EpochStatus.Executed;

        resetData();
        emit InteractionPoolOpen();
    }

    /**
     * @notice Executes all interactions within a specific domain.
     * @param domainId The ID of the domain whose interactions need to be executed.
     */
    function executeDomain(uint domainId) internal {
        for (
            uint j = 0;
            j < domains[domainId].ordered_interactions.length;
            j++
        ) {
            uint interactionIndex = domains[domainId].ordered_interactions[j];
            uint instanceId = pending_interactions[interactionIndex].instance;
            string memory taskName = pending_interactions[interactionIndex]
                .task;

            // Using call method to avoid cascading reverts
            (bool success, bytes memory data) = address(process).call(
                abi.encodeWithSignature(
                    "executeTask(uint256,string)",
                    instanceId,
                    taskName
                )
            );
        }

        // Mark the domain as executed after all interactions have been processed
        domains[domainId].status = DomainStatus.Executed;
    }

    /**
     * @notice Release interactions for execution.
     */
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
            address(process).call(
                abi.encodeWithSignature("executeTask", instanceId, taskName)
            );
        }
        resetData();
        emit InteractionPoolOpen();
    }

    /**
     * @notice Reset the state of the contract.
     */
    function resetData() internal {
        delete pending_interactions;
        index_block = 0;
    }
}

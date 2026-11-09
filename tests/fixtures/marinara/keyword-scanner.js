import { LIMITS, testPrimaryKeys, testSecondaryKeys } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { calibrateLorebookSimilarity } from "./embeddings.js";
import { vmRegexExecutor } from "./regex-timeout.js";
import { createSeededRandom } from "./seeded-random.js";
/** Compute cosine similarity between two vectors. Returns 0 for empty/mismatched vectors. */
function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}
/**
 * Evaluate activation conditions against game state.
 */
export function evaluateConditions(conditions, gameState) {
    if (conditions.length === 0)
        return true;
    if (!gameState)
        return true; // No game state = conditions pass (permissive)
    for (const condition of conditions) {
        const fieldValue = String(gameState[condition.field] ?? "");
        switch (condition.operator) {
            case "equals":
                if (fieldValue.toLowerCase() !== condition.value.toLowerCase())
                    return false;
                break;
            case "not_equals":
                if (fieldValue.toLowerCase() === condition.value.toLowerCase())
                    return false;
                break;
            case "contains":
                if (!fieldValue.toLowerCase().includes(condition.value.toLowerCase()))
                    return false;
                break;
            case "not_contains":
                if (fieldValue.toLowerCase().includes(condition.value.toLowerCase()))
                    return false;
                break;
            case "gt": {
                const actual = Number.parseFloat(fieldValue);
                const expected = Number.parseFloat(condition.value);
                if (!Number.isFinite(actual) || !Number.isFinite(expected))
                    return false;
                if (actual <= expected)
                    return false;
                break;
            }
            case "lt": {
                const actual = Number.parseFloat(fieldValue);
                const expected = Number.parseFloat(condition.value);
                if (!Number.isFinite(actual) || !Number.isFinite(expected))
                    return false;
                if (actual >= expected)
                    return false;
                break;
            }
        }
    }
    return true;
}
/**
 * Evaluate schedule conditions against game state.
 */
function evaluateSchedule(schedule, gameState) {
    if (!schedule)
        return true;
    if (!gameState)
        return true;
    // Check active times
    if (schedule.activeTimes.length > 0 && gameState.time) {
        const currentTime = String(gameState.time).toLowerCase();
        const matches = schedule.activeTimes.some((t) => currentTime.includes(t.toLowerCase()));
        if (!matches)
            return false;
    }
    // Check active dates
    if (schedule.activeDates.length > 0 && gameState.date) {
        const currentDate = String(gameState.date).toLowerCase();
        const matches = schedule.activeDates.some((d) => currentDate.includes(d.toLowerCase()));
        if (!matches)
            return false;
    }
    // Check active locations
    if (schedule.activeLocations.length > 0 && gameState.location) {
        const currentLoc = String(gameState.location).toLowerCase();
        const matches = schedule.activeLocations.some((l) => currentLoc.includes(l.toLowerCase()));
        if (!matches)
            return false;
    }
    return true;
}
/**
 * Check timing state (sticky/cooldown/delay).
 */
function checkTiming(entry, timingState) {
    if (!timingState)
        return !(entry.delay !== null && entry.delay > 0);
    // Delay: must wait N messages before first activation
    if (entry.delay !== null && entry.delay > 0) {
        if (timingState.delayRemaining > 0)
            return false;
    }
    // Cooldown: wait N messages between activations
    if (entry.cooldown !== null && entry.cooldown > 0) {
        if (timingState.cooldownRemaining > 0)
            return false;
    }
    return true;
}
function passesContextualActivationGate(entry, filterContext, gameState) {
    if (!entry.enabled)
        return false;
    if (!passesEntryFilters(entry, filterContext))
        return false;
    if (!evaluateConditions(entry.activationConditions, gameState))
        return false;
    if (!evaluateSchedule(entry.schedule, gameState))
        return false;
    return true;
}
function passesActivationGate(entry, timingState, filterContext, gameState, ignoreTiming = false) {
    if (!passesContextualActivationGate(entry, filterContext, gameState))
        return false;
    if (!ignoreTiming && !checkTiming(entry, timingState))
        return false;
    return true;
}
/** Apply non-keyword activation safeguards to an explicitly selected entry. */
export function passesForcedEntryActivationGates(entry, options = {}) {
    const filterContext = {
        activeCharacterIds: makeValueSet(options.activeCharacterIds),
        activeCharacterTags: makeValueSet(options.activeCharacterTags),
        generationTriggers: makeValueSet(options.generationTriggers && options.generationTriggers.length > 0 ? options.generationTriggers : ["chat"]),
    };
    if (!passesActivationGate(entry, options.timingStates?.get(entry.id), filterContext, options.gameState ?? null, options.ignoreTiming)) {
        return false;
    }
    // Short-circuit BEFORE the shared decision map is read or written: seeding a
    // `true` into `probabilityDecisions` would suppress the roll on the ordinary
    // keyword path too, because the same map is reused across the whole scan.
    if (options.ignoreProbability)
        return true;
    const existingDecision = options.probabilityDecisions?.get(entry.id);
    if (existingDecision !== undefined)
        return existingDecision;
    const passes = passesProbabilityGate(entry, options.random ?? Math.random);
    options.probabilityDecisions?.set(entry.id, passes);
    return passes;
}
function normalizeProbability(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : null;
    if (parsed === null || !Number.isFinite(parsed))
        return null;
    return Math.max(0, Math.min(100, parsed));
}
function passesProbabilityGate(entry, random) {
    const probability = normalizeProbability(entry.probability);
    if (probability === null || probability >= 100)
        return true;
    if (probability <= 0)
        return false;
    return random() * 100 < probability;
}
function hasTimingConfig(entry) {
    return ((entry.sticky !== null && entry.sticky > 0) ||
        (entry.cooldown !== null && entry.cooldown > 0) ||
        (entry.delay !== null && entry.delay > 0));
}
function cloneTimingState(state) {
    return {
        lastActivatedAt: state.lastActivatedAt,
        stickyCount: state.stickyCount,
        cooldownRemaining: state.cooldownRemaining,
        delayRemaining: state.delayRemaining,
    };
}
function shouldPersistTimingState(entry, state) {
    if (state.stickyCount > 0 || state.cooldownRemaining > 0 || state.delayRemaining > 0)
        return true;
    if (entry.delay !== null && entry.delay > 0)
        return true;
    return false;
}
export function updateTimingStatesForScan(entries, activatedEntries, previousStates = new Map(), currentMessageIndex) {
    const nextStates = new Map();
    const activatedById = new Map(activatedEntries.map((entry) => [entry.entry.id, entry]));
    for (const entry of entries) {
        if (!hasTimingConfig(entry))
            continue;
        const previous = previousStates.get(entry.id);
        const state = previous
            ? cloneTimingState(previous)
            : {
                lastActivatedAt: null,
                stickyCount: 0,
                cooldownRemaining: 0,
                delayRemaining: entry.delay !== null && entry.delay > 0 ? entry.delay : 0,
            };
        const activated = activatedById.get(entry.id);
        if (activated && !activated.sticky) {
            state.lastActivatedAt = currentMessageIndex;
            state.stickyCount = entry.sticky !== null && entry.sticky > 0 ? entry.sticky : 0;
            state.cooldownRemaining = entry.cooldown !== null && entry.cooldown > 0 ? entry.cooldown : 0;
            state.delayRemaining = 0;
        }
        else {
            if (state.delayRemaining > 0)
                state.delayRemaining -= 1;
            if (state.stickyCount > 0) {
                state.stickyCount -= 1;
            }
            else if (state.cooldownRemaining > 0) {
                state.cooldownRemaining -= 1;
            }
        }
        if (shouldPersistTimingState(entry, state)) {
            nextStates.set(entry.id, state);
        }
    }
    return nextStates;
}
function normalizeFilterValue(value) {
    return value.trim().toLowerCase();
}
function makeValueSet(values) {
    return new Set((values ?? []).map(normalizeFilterValue).filter(Boolean));
}
function passesValueFilter(mode, filters, activeValues) {
    const normalizedMode = mode ?? "any";
    const filterValues = makeValueSet(filters);
    if (normalizedMode === "any" || filterValues.size === 0)
        return true;
    const hasMatch = Array.from(filterValues).some((value) => activeValues.has(value));
    return normalizedMode === "include" ? hasMatch : !hasMatch;
}
function passesEntryFilters(entry, context) {
    return (passesValueFilter(entry.characterFilterMode, entry.characterFilterIds, context.activeCharacterIds) &&
        passesValueFilter(entry.characterTagFilterMode, entry.characterTagFilters, context.activeCharacterTags) &&
        passesValueFilter(entry.generationTriggerFilterMode, entry.generationTriggerFilters, context.generationTriggers));
}
export function lorebookEntryPassesContextFilters(entry, options) {
    return passesEntryFilters(entry, {
        activeCharacterIds: makeValueSet(options.activeCharacterIds),
        activeCharacterTags: makeValueSet(options.activeCharacterTags),
        generationTriggers: makeValueSet(options.generationTriggers?.length ? options.generationTriggers : ["chat"]),
    });
}
function getAdditionalMatchingText(entry, sourceText) {
    if (!entry.additionalMatchingSources?.length)
        return "";
    return entry.additionalMatchingSources
        .map((source) => sourceText[source]?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
}
/**
 * Group-based selection: within a group, only activate entries up to weight limits.
 */
function getGroupWeight(entry) {
    const weight = Number(entry.entry.groupWeight ?? 100);
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
}
function pickWeightedGroupEntry(entries, random) {
    if (entries.length === 0)
        return null;
    const totalWeight = entries.reduce((total, entry) => total + getGroupWeight(entry), 0);
    if (totalWeight <= 0) {
        return [...entries].sort((a, b) => a.entry.order - b.entry.order)[0] ?? null;
    }
    let roll = random() * totalWeight;
    for (const entry of entries) {
        roll -= getGroupWeight(entry);
        if (roll <= 0)
            return entry;
    }
    return entries[entries.length - 1] ?? null;
}
/**
 * A repeatable random source for one inclusion group. The same seed, group and candidate entries always give the
 * same winner, so the prompt does not change between turns when nothing about the group changed (a new random winner
 * every turn rewrites the lore near the top of the prompt and breaks prompt caching). It still varies across chats and
 * whenever the set of activated candidates changes.
 */
function seededGroupRandom(seed, group, entries) {
    const key = `${seed}|${group}|${entries
        .map((entry) => entry.entry.id)
        .sort()
        .join(",")}`;
    return createSeededRandom(key);
}
function applyGroupSelection(entries, random, groupSeed) {
    const grouped = new Map();
    const ungrouped = [];
    for (const entry of entries) {
        const group = entry.entry.group;
        if (group) {
            const list = grouped.get(group) ?? [];
            list.push(entry);
            grouped.set(group, list);
        }
        else {
            ungrouped.push(entry);
        }
    }
    const result = [...ungrouped];
    for (const [group, groupEntries] of grouped) {
        const stickyEntries = groupEntries.filter((entry) => entry.sticky);
        const pool = stickyEntries.length > 0 ? stickyEntries : groupEntries;
        // A seeded roll must map to the same entry whatever order the candidates activated in, so seeded picks use id order.
        const candidates = groupSeed
            ? [...pool].sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
            : pool;
        const selected = pickWeightedGroupEntry(candidates, groupSeed ? seededGroupRandom(groupSeed, group, candidates) : random);
        if (selected)
            result.push(selected);
    }
    return result;
}
/**
 * Main scanning function: given messages and lorebook entries,
 * returns the list of activated entries.
 */
export function scanForActivatedEntries(messages, entries, options = {}) {
    const { scanDepth = 0, gameState = null, timingStates = new Map(), chatEmbedding = null, semanticEmbeddingsByLorebookId = new Map(), semanticEmbeddingSpaceId = null, semanticThreshold = 0.3, semanticSimilarityBaseline = 0, semanticThresholdByLorebookId = new Map(), semanticMaxMatchesByLorebookId = new Map(), activeCharacterIds = [], activeCharacterTags = [], generationTriggers = ["chat"], additionalMatchingSourceText = {}, pinnedScanMessages = [], ignoreTiming = false, recursionPass = false, probabilityDecisions = new Map(), random = Math.random, decisionAnswers, pendingDecisions, } = options;
    // Decision activation (#6570). Asked only once an entry would otherwise activate,
    // after its filters, timing, keywords and probability roll, so a statement is never
    // paid for when the entry would be skipped anyway. No answer reads as no.
    const decisionIsYes = (entry) => {
        const answer = decisionAnswers?.get(entry.id);
        if (answer === undefined)
            pendingDecisions?.add(entry.id);
        return answer === true;
    };
    const requiresDecision = (entry) => entry.decisionMode === "require" && entry.decisionStatement?.trim().length > 0;
    const triggersOnDecision = (entry) => entry.decisionMode === "trigger" && entry.decisionStatement?.trim().length > 0;
    const filterContext = {
        activeCharacterIds: makeValueSet(activeCharacterIds),
        activeCharacterTags: makeValueSet(activeCharacterTags),
        generationTriggers: makeValueSet(generationTriggers.length > 0 ? generationTriggers : ["chat"]),
    };
    const pinnedScanText = pinnedScanMessages
        .map((message) => message.content.trim())
        .filter(Boolean)
        .join("\n");
    const appendPinnedScanText = (baseText, includePinned = true) => {
        if (!includePinned || !pinnedScanText)
            return baseText;
        return baseText ? `${baseText}\n${pinnedScanText}` : pinnedScanText;
    };
    // Build the text to scan from recent messages
    const messagesToScan = scanDepth > 0 ? messages.slice(-scanDepth) : messages;
    const combinedText = appendPinnedScanText(messagesToScan.map((m) => m.content).join("\n"));
    const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const latestUserText = latestUserMessage?.content ?? "";
    const activated = [];
    const activatedIds = new Set();
    const passesEntryProbability = (entry) => {
        const existing = probabilityDecisions.get(entry.id);
        if (existing !== undefined)
            return existing;
        const passes = passesProbabilityGate(entry, random);
        probabilityDecisions.set(entry.id, passes);
        return passes;
    };
    const getEntryScanText = (entry) => {
        // Per-entry scan depth:
        //   0    = explicit "scan all" (deliberate user choice) — scan full history
        //   > 0  = scan that many recent messages
        //   null = inherit the bounded global default (combinedText)
        const baseEntryScanText = entry.scanDepth === 0
            ? appendPinnedScanText(messages.map((m) => m.content).join("\n"), false)
            : entry.scanDepth !== null && entry.scanDepth > 0
                ? appendPinnedScanText(messages
                    .slice(-entry.scanDepth)
                    .map((m) => m.content)
                    .join("\n"))
                : combinedText;
        const extraMatchingText = getAdditionalMatchingText(entry, additionalMatchingSourceText);
        return extraMatchingText ? `${baseEntryScanText}\n${extraMatchingText}` : baseEntryScanText;
    };
    for (const entry of entries) {
        if (entry.delayUntilRecursion && !recursionPass)
            continue;
        if (entry.excludeRecursion && recursionPass)
            continue;
        const timingState = timingStates.get(entry.id);
        if (!ignoreTiming && timingState?.stickyCount && timingState.stickyCount > 0) {
            if (!passesContextualActivationGate(entry, filterContext, gameState))
                continue;
            activated.push({
                entry,
                matchedKeys: ["[sticky]"],
                injectionOrder: entry.order,
                activationSources: ["sticky"],
                sticky: true,
            });
            activatedIds.add(entry.id);
            continue;
        }
        if (!passesActivationGate(entry, timingState, filterContext, gameState, ignoreTiming))
            continue;
        // Constant entries still activate without keywords, but they obey timing,
        // context filters, activation conditions, schedule, and probability gates.
        if (entry.constant) {
            if (!passesEntryProbability(entry))
                continue;
            if (requiresDecision(entry) && !decisionIsYes(entry))
                continue;
            activated.push({
                entry,
                matchedKeys: ["[constant]"],
                injectionOrder: entry.order,
                activationSources: [recursionPass ? "recursive" : "constant"],
            });
            activatedIds.add(entry.id);
            continue;
        }
        const entryScanText = getEntryScanText(entry);
        const matchOptions = {
            useRegex: entry.useRegex,
            matchWholeWords: entry.matchWholeWords,
            caseSensitive: entry.caseSensitive,
            regexExecutor: vmRegexExecutor,
        };
        // A Trigger statement can activate the entry whenever its keywords do not: the
        // primary keys miss, or they match but the secondary-key logic rejects them.
        const tryDecisionTrigger = () => {
            if (!triggersOnDecision(entry) || !passesEntryProbability(entry) || !decisionIsYes(entry))
                return;
            activated.push({
                entry,
                matchedKeys: ["[decision]"],
                activationSources: ["decision"],
                injectionOrder: entry.order,
            });
            activatedIds.add(entry.id);
        };
        // Test primary keys
        const { matched, matchedKeys } = testPrimaryKeys(entry.keys, entryScanText, matchOptions);
        if (!matched) {
            tryDecisionTrigger();
            continue;
        }
        const matchedCurrentContext = latestUserText.length > 0 ? testPrimaryKeys(entry.keys, latestUserText, matchOptions).matched : false;
        // Test secondary keys (selective mode)
        if (entry.selective && entry.secondaryKeys.length > 0) {
            if (!testSecondaryKeys(entry.secondaryKeys, entryScanText, entry.selectiveLogic, matchOptions)) {
                tryDecisionTrigger();
                continue;
            }
        }
        if (!passesEntryProbability(entry))
            continue;
        if (requiresDecision(entry) && !decisionIsYes(entry))
            continue;
        activated.push({
            entry,
            matchedKeys,
            matchedCurrentContext,
            activationSources: [recursionPass ? "recursive" : "keyword"],
            injectionOrder: entry.order,
        });
        activatedIds.add(entry.id);
    }
    // ── Semantic matching: add vector matches that weren't already activated ──
    if ((chatEmbedding && chatEmbedding.length > 0) ||
        Array.from(semanticEmbeddingsByLorebookId.values()).some((embedding) => embedding && embedding.length > 0)) {
        const semanticCandidates = [];
        for (const entry of entries) {
            if (!entry.enabled || entry.constant || activatedIds.has(entry.id))
                continue;
            if (entry.delayUntilRecursion && !recursionPass)
                continue;
            if (entry.excludeRecursion && recursionPass)
                continue;
            if (entry.excludeFromVectorization)
                continue;
            if (!entry.embedding || entry.embedding.length === 0)
                continue;
            const queryEmbedding = semanticEmbeddingsByLorebookId.get(entry.lorebookId) ?? chatEmbedding;
            if (!queryEmbedding || queryEmbedding.length === 0)
                continue;
            if (semanticEmbeddingSpaceId && entry.embeddingSpaceId !== semanticEmbeddingSpaceId) {
                logger.debug("[lorebook-vectors] Rejected entry %s: stored vector space %s differs from active space %s", entry.id, entry.embeddingSpaceId, semanticEmbeddingSpaceId);
                continue;
            }
            const queryVectors = (Array.isArray(queryEmbedding[0]) ? queryEmbedding : [queryEmbedding]).filter((vector) => vector.length === entry.embedding.length);
            if (queryVectors.length === 0) {
                logger.debug("[lorebook-vectors] Rejected entry %s: no query matches stored dimension %d", entry.id, entry.embedding.length);
                continue;
            }
            const timingState = timingStates.get(entry.id);
            if (!passesActivationGate(entry, timingState, filterContext, gameState, ignoreTiming))
                continue;
            const threshold = semanticThresholdByLorebookId.get(entry.lorebookId) ?? semanticThreshold;
            const rawSimilarity = Math.max(...queryVectors.map((vector) => cosineSimilarity(vector, entry.embedding)));
            const similarity = calibrateLorebookSimilarity(rawSimilarity, semanticSimilarityBaseline);
            logger.debug("[lorebook-vectors] Scored entry %s: raw=%d calibrated=%d baseline=%d threshold=%d accepted=%s", entry.id, rawSimilarity, similarity, semanticSimilarityBaseline, threshold, similarity >= threshold);
            if (similarity >= threshold) {
                const entryScanText = getEntryScanText(entry);
                const matchOptions = {
                    useRegex: entry.useRegex,
                    matchWholeWords: entry.matchWholeWords,
                    caseSensitive: entry.caseSensitive,
                    regexExecutor: vmRegexExecutor,
                };
                if (entry.selective &&
                    entry.secondaryKeys.length > 0 &&
                    !testSecondaryKeys(entry.secondaryKeys, entryScanText, entry.selectiveLogic, matchOptions)) {
                    continue;
                }
                if (!passesEntryProbability(entry))
                    continue;
                semanticCandidates.push({ entry, similarity });
            }
        }
        const semanticCountsByLorebookId = new Map();
        // Require statements are asked in similarity order, and only for as many matches as
        // could still be selected, so a weaker match never takes a stronger one's question.
        const pendingCountsByLorebookId = new Map();
        for (const candidate of semanticCandidates.sort((a, b) => b.similarity - a.similarity)) {
            const lorebookId = candidate.entry.lorebookId;
            const maxMatches = semanticMaxMatchesByLorebookId.get(lorebookId) ?? LIMITS.LOREBOOK_VECTOR_MAX_RESULTS_DEFAULT;
            const selectedCount = semanticCountsByLorebookId.get(lorebookId) ?? 0;
            const pendingCount = pendingCountsByLorebookId.get(lorebookId) ?? 0;
            if (selectedCount + pendingCount >= maxMatches)
                continue;
            if (requiresDecision(candidate.entry)) {
                const answer = decisionAnswers?.get(candidate.entry.id);
                if (answer === undefined) {
                    // Only a pre-scan can still ask it, so only a pre-scan holds its slot; in
                    // the final scan an unanswered statement is a no and frees the slot.
                    if (pendingDecisions) {
                        pendingDecisions.add(candidate.entry.id);
                        pendingCountsByLorebookId.set(lorebookId, pendingCount + 1);
                    }
                    continue;
                }
                if (!answer)
                    continue;
            }
            activated.push({
                entry: candidate.entry,
                matchedKeys: [`[semantic:${candidate.similarity.toFixed(3)}]`],
                // Semantic candidates describe the same current scan context as a key
                // matched in the latest user turn. Giving both this marker keeps the
                // budget selector neutral between keyword and vector activation.
                matchedCurrentContext: latestUserText.length > 0,
                injectionOrder: candidate.entry.order,
                activationSources: [recursionPass ? "recursive" : "semantic"],
            });
            activatedIds.add(candidate.entry.id);
            semanticCountsByLorebookId.set(lorebookId, selectedCount + 1);
        }
    }
    // Apply group selection
    const afterGroups = applyGroupSelection(activated, random, options.groupSeed);
    // Sort by injection order (lower = higher priority)
    afterGroups.sort((a, b) => a.injectionOrder - b.injectionOrder);
    return afterGroups;
}
/**
 * Recursive scanning: re-scan activated entry content for additional matches.
 */
export function recursiveScan(messages, entries, options = {}, maxDepth = 3, 
/** Which entries take part in recursion, both driving it and being reached by it. */
canRecurse = () => true) {
    const probabilityDecisions = options.probabilityDecisions ?? new Map();
    const scanOptions = { ...options, probabilityDecisions };
    const allActivated = scanForActivatedEntries(messages, entries, scanOptions);
    const activatedIds = new Set(allActivated.map((a) => a.entry.id));
    let newlyActivated = allActivated;
    for (let depth = 0; depth < maxDepth; depth++) {
        // Build text from newly activated entries, excluding those with preventRecursion
        const newContent = newlyActivated
            .filter((a) => !a.entry.preventRecursion && canRecurse(a.entry))
            .map((a) => a.entry.content)
            .join("\n");
        if (!newContent)
            break;
        // Scan remaining entries against the content of activated entries
        const remaining = entries.filter((e) => !activatedIds.has(e.id) && !e.excludeRecursion && canRecurse(e));
        const newMessages = [{ role: "system", content: newContent }];
        const newActivated = scanForActivatedEntries(newMessages, remaining, {
            ...scanOptions,
            pinnedScanMessages: [],
            chatEmbedding: null,
            recursionPass: true,
        });
        if (newActivated.length === 0)
            break;
        newlyActivated = [];
        for (const a of newActivated) {
            activatedIds.add(a.entry.id);
            allActivated.push(a);
            newlyActivated.push(a);
        }
    }
    return allActivated;
}

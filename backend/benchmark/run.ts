/**
 * MemoryGuard policy benchmark runner.
 *
 * Evaluates the /policies/policies.ts evaluator against each entry in corpus.ts
 * and calculates precision, recall, false-positive count, and per-category
 * breakdown from ACTUAL evaluation results — values are never invented.
 *
 * Usage:
 *   npx tsx benchmark/run.ts
 *
 * This script reads no external data, makes no network requests,
 * and does not expose real credentials.
 */

import { evaluate } from '../src/policies/policies.js';
import { CORPUS, type CorpusEntry, type ExpectedOutcome } from './corpus.js';

interface EvalResult {
    entry: CorpusEntry;
    actualTriggered: boolean;
    actualConfidence: string | undefined;
    /** null for benign expected outcomes (they are not TP/FP in terms of detection). */
    classification: 'TP' | 'FP' | 'FN' | 'TN';
}

function classifyResult(expected: ExpectedOutcome, triggered: boolean): EvalResult['classification'] {
    // 'conflict' and 'signal' are both positive (should-detect) outcomes.
    const shouldDetect = expected === 'conflict' || expected === 'signal';
    if (shouldDetect && triggered) return 'TP';
    if (shouldDetect && !triggered) return 'FN';
    if (!shouldDetect && triggered) return 'FP';
    return 'TN';
}

function pct(n: number, d: number): string {
    if (d === 0) return 'N/A';
    return `${((n / d) * 100).toFixed(1)}%`;
}

function run(): void {
    const results: EvalResult[] = CORPUS.map((entry) => {
        const ev = evaluate({
            content: entry.content,
            sourceType: entry.sourceType,
            sourceTrusted: entry.sourceTrusted,
        });
        const classification = classifyResult(entry.expected, ev.triggered);
        return {
            entry,
            actualTriggered: ev.triggered,
            actualConfidence: ev.confidence,
            classification,
        };
    });

    const TP = results.filter((r) => r.classification === 'TP').length;
    const FP = results.filter((r) => r.classification === 'FP').length;
    const FN = results.filter((r) => r.classification === 'FN').length;
    const TN = results.filter((r) => r.classification === 'TN').length;

    const precision = TP / (TP + FP);
    const recall = TP / (TP + FN);

    // ─── Print results ──────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════');
    console.log('  MemoryGuard Policy Evaluation Benchmark');
    console.log('══════════════════════════════════════════════\n');
    console.log(`${'ID'.padEnd(6)}${'EXPECTED'.padEnd(12)}${'TRIGGERED'.padEnd(11)}${'CONFIDENCE'.padEnd(18)}RESULT`);
    console.log('─'.repeat(65));
    for (const r of results) {
        const triggered = r.actualTriggered ? 'yes' : 'no';
        const conf = r.actualConfidence ?? '—';
        console.log(
            `${r.entry.id.padEnd(6)}${r.entry.expected.padEnd(12)}${triggered.padEnd(11)}${conf.padEnd(18)}${r.classification}`,
        );
    }
    console.log('─'.repeat(65));

    console.log(`\nTP=${TP}  FP=${FP}  FN=${FN}  TN=${TN}`);
    console.log(`Precision : ${pct(TP, TP + FP)}  (correctness of positive detections)`);
    console.log(`Recall    : ${pct(TP, TP + FN)}  (coverage of true positives)`);
    console.log(`False positives: ${FP}`);

    // ─── Per-category breakdown ─────────────────────────────────────────────────
    const categories = [...new Set(CORPUS.map((e) => e.category))];
    console.log('\nPer-category breakdown:');
    for (const cat of categories) {
        const catResults = results.filter((r) => r.entry.category === cat);
        const catTP = catResults.filter((r) => r.classification === 'TP').length;
        const catFN = catResults.filter((r) => r.classification === 'FN').length;
        const catFP = catResults.filter((r) => r.classification === 'FP').length;
        console.log(`  ${cat.padEnd(32)} TP=${catTP} FP=${catFP} FN=${catFN}`);
    }

    // ─── Heuristic limits commentary ────────────────────────────────────────────
    const provenanceOnly = results.filter((r) => r.entry.provenanceDependent);
    if (provenanceOnly.length > 0) {
        console.log('\nKnown heuristic limits:');
        console.log(
            `  ${provenanceOnly.length} entry(ies) are marked provenanceDependent — their correct classification`,
        );
        console.log(
            '  requires graph lineage context that regex/keyword policies cannot provide.',
        );
        console.log('  These are documented FNs, not bugs.');
        for (const r of provenanceOnly) {
            console.log(`    ${r.entry.id}: ${r.entry.notes}`);
        }
    }

    console.log('\n══════════════════════════════════════════════\n');

    // Exit non-zero if any unexpected FP is found (provenanceDependent FNs are accepted).
    const unexpectedFP = results.filter((r) => r.classification === 'FP');
    if (unexpectedFP.length > 0) {
        console.error(`Benchmark failed: ${unexpectedFP.length} unexpected false positive(s):`);
        for (const r of unexpectedFP) console.error(`  ${r.entry.id}: ${r.entry.notes}`);
        process.exit(1);
    }
}

run();

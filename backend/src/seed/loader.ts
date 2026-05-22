/**
 * Idempotent YAML seed loader.
 * Run on every backend boot (auto) or manually via `npm run seed`.
 *
 * Algorithm:
 *  1. Hash tree.yaml and knockouts.yaml
 *  2. Compare against stored hashes on the active BiasProfile / Knockouts
 *  3. If changed → upsert nodes / knockouts, increment BiasProfile.version, write AuditLog
 *  4. Always ensure exactly one active BiasProfile exists
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import yaml from 'js-yaml';
import { connectDb, disconnectDb } from '../db';
import { BiasProfile } from '../models/BiasProfile';
import { TreeNode } from '../models/TreeNode';
import { Knockout } from '../models/Knockout';
import { AuditLog } from '../models/AuditLog';

const SEED_DIR = join(__dirname);

function hashFile(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function readYaml<T>(filePath: string): T {
  return yaml.load(readFileSync(filePath, 'utf-8')) as T;
}

interface TreeYaml {
  version: number;
  biasProfile: {
    name: string;
    description?: string;
    threshold: number;
    categoryMultipliers: {
      required: number;
      must_have: number;
      good_to_have: number;
      not_required: number;
    };
    categoryShares: {
      required: number;
      must_have: number;
      good_to_have: number;
      not_required: number;
    };
    reconciliation: Record<string, unknown>;
  };
  nodes: Array<{
    nodeId: string;
    kind: string;
    parentId?: string;
    name: string;
    description?: string;
    category: string;
    weight: number;
    enabled: boolean;
    order: number;
    sourceType?: string;
    sourceRef?: string;
    signalKey?: string;
    scoringRule?: Record<string, unknown>;
    flags?: string[];
  }>;
}

interface KnockoutsYaml {
  version: number;
  knockouts: Array<{
    id: string;
    name: string;
    enabled: boolean;
    severity: string;
    notes?: string;
    rule: unknown;
  }>;
}

/** Validate that sibling weights sum to ~100 per parent. Warns only. */
function validateWeights(nodes: TreeYaml['nodes']): void {
  const byParent = new Map<string, number[]>();

  for (const node of nodes) {
    if (!node.enabled) continue;
    const parent = node.parentId ?? '_root';
    const arr = byParent.get(parent) ?? [];
    arr.push(node.weight);
    byParent.set(parent, arr);
  }

  for (const [parent, weights] of byParent) {
    const sum = weights.reduce((a, b) => a + b, 0);
    // Allow root-level tracks to not sum to 100 (they are scaled by their weight only)
    if (parent === '_root') continue;
    if (Math.abs(sum - 100) > 1) {
      console.warn(`[Seed] Weight validation warning: children of "${parent}" sum to ${sum.toFixed(1)} (expected 100)`);
    }
  }
}

export async function runSeed(standalone = false): Promise<void> {
  if (standalone) {
    await connectDb();
  }

  const treeYamlPath = join(SEED_DIR, 'tree.yaml');
  const knockoutsYamlPath = join(SEED_DIR, 'knockouts.yaml');

  const treeHash = hashFile(treeYamlPath);
  const knockoutsHash = hashFile(knockoutsYamlPath);

  console.info('[Seed] Checking YAML hashes…');

  // ── Ensure one active BiasProfile exists ─────────────────────────────────
  let profile = await BiasProfile.findOne({ isActive: true });

  const treeChanged = !profile || profile.yamlHash !== treeHash;

  if (treeChanged) {
    const treeYaml = readYaml<TreeYaml>(treeYamlPath);
    validateWeights(treeYaml.nodes);

    if (!profile) {
      profile = new BiasProfile({
        name: treeYaml.biasProfile.name,
        description: treeYaml.biasProfile.description ?? '',
        isActive: true,
        threshold: treeYaml.biasProfile.threshold,
        categoryMultipliers: treeYaml.biasProfile.categoryMultipliers,
        categoryShares: treeYaml.biasProfile.categoryShares,
        reconciliation: treeYaml.biasProfile.reconciliation,
        version: 1,
        yamlHash: treeHash,
      });
      await profile.save();
      console.info('[Seed] Created new BiasProfile:', profile.name);
    } else {
      const before = { version: profile.version, yamlHash: profile.yamlHash };
      profile.version += 1;
      profile.yamlHash = treeHash;
      profile.categoryMultipliers = treeYaml.biasProfile.categoryMultipliers as typeof profile.categoryMultipliers;
      profile.categoryShares = treeYaml.biasProfile.categoryShares as typeof profile.categoryShares;
      profile.threshold = treeYaml.biasProfile.threshold;
      await profile.save();
      console.info(`[Seed] BiasProfile updated to version ${profile.version}`);

      await AuditLog.create({
        actor: 'system',
        action: 'yaml_reseed',
        target: `biasProfiles/${profile._id}`,
        before,
        after: { version: profile.version, yamlHash: treeHash },
        at: new Date(),
      });
    }

    // Upsert all tree nodes
    let upserted = 0;
    for (const node of treeYaml.nodes) {
      await TreeNode.findOneAndUpdate(
        { biasProfileId: profile._id, nodeId: node.nodeId },
        {
          biasProfileId: profile._id,
          nodeId: node.nodeId,
          parentId: node.parentId,
          kind: node.kind,
          name: node.name,
          description: node.description,
          category: node.category,
          weight: node.weight,
          enabled: node.enabled,
          sourceType: node.sourceType,
          sourceRef: node.sourceRef,
          signalKey: node.signalKey,
          scoringRule: node.scoringRule,
          flags: node.flags ?? [],
          order: node.order,
          yamlHash: treeHash,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      upserted++;
    }
    console.info(`[Seed] Upserted ${upserted} tree nodes`);
  } else {
    console.info('[Seed] tree.yaml unchanged — skipping tree reseed');
  }

  // ── Knockouts ─────────────────────────────────────────────────────────────
  const existingKnockout = await Knockout.findOne();
  const knockoutsChanged = !existingKnockout || existingKnockout.yamlHash !== knockoutsHash;

  if (knockoutsChanged) {
    const knockoutsYaml = readYaml<KnockoutsYaml>(knockoutsYamlPath);

    for (const ko of knockoutsYaml.knockouts) {
      const before = await Knockout.findOne({ knockoutId: ko.id });

      await Knockout.findOneAndUpdate(
        { knockoutId: ko.id },
        {
          knockoutId: ko.id,
          name: ko.name,
          enabled: ko.enabled,
          severity: ko.severity,
          notes: ko.notes,
          rule: ko.rule,
          yamlHash: knockoutsHash,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      if (before) {
        await AuditLog.create({
          actor: 'system',
          action: 'yaml_reseed',
          target: `knockouts/${ko.id}`,
          before: { enabled: before.enabled, severity: before.severity },
          after: { enabled: ko.enabled, severity: ko.severity },
          at: new Date(),
        });
      }
    }
    console.info(`[Seed] Upserted ${knockoutsYaml.knockouts.length} knockouts`);
  } else {
    console.info('[Seed] knockouts.yaml unchanged — skipping knockout reseed');
  }

  console.info('[Seed] Done');

  if (standalone) {
    await disconnectDb();
    process.exit(0);
  }
}

// Allow running directly: npx tsx src/seed/loader.ts
if (require.main === module) {
  runSeed(true).catch((err) => {
    console.error('[Seed] Fatal error:', err);
    process.exit(1);
  });
}

/**
 * Gate: this daemon's device posture composition serves the WHOLE devices.*
 * family over the gateway — including the three verbs that ask a paired phone
 * for something and read back what it sent.
 *
 * Why this file exists. The paired-phone feature is platform-owned, but the
 * seams are this daemon's: the peer transport devices pair onto, the shared
 * approval broker the confirmation rides, the config manager the posture is
 * read from, and the state directory the grants and captures live in
 * (runtime/device-posture-composition.ts). Binding the catalog to that runtime
 * is what turns the family from cataloged-but-unhandled into handlers.
 *
 * Until devices.capability.request existed, a surface with no device runtime of
 * its own could list the grants and revoke them and could never open a camera —
 * the feature was reachable only through the `phone` tool, in-process. This test
 * drives the wire path end to end over this composition: the request reaches the
 * real capability service, the person is asked through the real approval seam,
 * the bytes the device returned are retained by the real capture store, and the
 * caller reads them back by id. It also pins the properties that must NOT move
 * to the route — the confirmation, the durable grant, and the refusals — because
 * a second place those get decided is a second place they can be decided
 * differently.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  DEVICE_CAPABILITY_IDS,
} from '@pellux/goodvibes-sdk/platform/devices';
import type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePeerView,
} from '@pellux/goodvibes-sdk/platform/devices';
import { createDevicePostureServices, TUI_DEVICE_ACTOR } from '../../runtime/device-posture-composition.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const DEVICE_METHOD_IDS = [
  'devices.nodes.list',
  'devices.capability.request',
  'devices.artifacts.list',
  'devices.artifacts.read',
  'devices.grants.list',
  'devices.grants.revoke',
  'devices.housekeeping.run',
] as const;

/** PNG-ish bytes; the store only cares that what comes back is what went in. */
const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7, 7]);

const runtimes: Array<{ stopHousekeeping: () => void }> = [];
afterAll(() => {
  for (const runtime of runtimes.splice(0)) runtime.stopHousekeeping();
});

interface Harness {
  readonly catalog: GatewayMethodCatalog;
  readonly asks: Array<{ tool: string; capability: unknown; reason: unknown }>;
  readonly dispatched: string[];
  approve(decision: 'once' | 'always' | 'deny'): void;
  sendBytes(send: boolean): void;
}

function pairedPhone(): DevicePeerView {
  return {
    id: 'phone-1',
    label: 'Pixel on the desk',
    kind: 'device',
    platform: 'android',
    version: '1.0.0',
    status: 'connected',
    capabilities: [...DEVICE_CAPABILITY_IDS],
    metadata: {
      [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
        nodeKind: 'web-pwa',
        contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
        capabilities: [...DEVICE_CAPABILITY_IDS],
        secureContext: true,
      },
    },
  };
}

function harness(): Harness {
  const root = makeProjectTempDir('gv-daemon-device-verbs-');
  const asks: Harness['asks'] = [];
  const dispatched: string[] = [];
  let decision: 'once' | 'always' | 'deny' = 'once';
  let sendBytes = false;

  const transport: DevicePeerTransport = {
    listPeers: (kind) => (kind === undefined || kind === 'device' ? [pairedPhone()] : []),
    invokePeer: async (input) => {
      dispatched.push(input.command);
      return {
        completed: true,
        work: {
          id: 'work-1',
          status: 'completed',
          result: {
            contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
            capabilityId: input.command,
            ok: true,
            data: { echoed: input.command },
            ...(sendBytes
              ? {
                mediaBase64: Buffer.from(CAPTURE_BYTES).toString('base64'),
                mediaType: 'image/png',
              }
              : {}),
          },
        },
      };
    },
  };

  const approvals: DeviceApprovalBridge = {
    requestApproval: async ({ request }) => {
      asks.push({
        tool: request.tool,
        capability: request.args.capability,
        reason: request.args.reason,
      });
      if (decision === 'deny') return { approved: false, reason: 'not right now' };
      return decision === 'always'
        ? { approved: true, rememberTier: 'tool' as const }
        : { approved: true };
    },
  };

  const catalog = new GatewayMethodCatalog();
  const { devicePosture } = createDevicePostureServices({
    configManager: new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' }),
    distributedRuntime: transport,
    approvals,
    stateDirectory: join(root, 'devices'),
    gatewayMethods: catalog,
  });
  // Nothing here starts housekeeping; the disposer is registered so a future
  // change that does cannot leave a timer running past this file.
  runtimes.push(devicePosture);

  return {
    catalog,
    asks,
    dispatched,
    approve(next) { decision = next; },
    sendBytes(next) { sendBytes = next; },
  };
}

const CONTEXT = { context: { admin: true } } as const;

describe('the composed daemon serves the whole devices.* family', () => {
  test('every device verb is cataloged and handled, not a 501 facade', () => {
    const h = harness();
    for (const id of DEVICE_METHOD_IDS) {
      expect(h.catalog.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(h.catalog.hasHandler(id), `${id} has no handler`).toBe(true);
    }
  });

  test('the paired phone this daemon\'s transport reports is the one the verbs see', async () => {
    const h = harness();
    const listed = await h.catalog.invoke('devices.nodes.list', { ...CONTEXT, body: {} }) as {
      nodes: readonly { nodeId: string; label: string }[];
    };
    expect(listed.nodes.map((node) => node.nodeId)).toEqual(['phone-1']);
    expect(listed.nodes[0]?.label).toBe('Pixel on the desk');
  });

  test('a request goes through this daemon\'s approval seam and out over its transport', async () => {
    const h = harness();
    const result = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: {
        nodeId: 'phone-1',
        capabilityId: 'device.command.vibrate',
        reason: 'confirming which phone is on the desk',
      },
    }) as { ok: boolean; authority: string; data?: unknown };

    expect(result.ok).toBe(true);
    expect(result.authority).toBe('confirmed-once');
    // The prompt rode the shared approval broker seam, carrying the caller's
    // reason verbatim — that is what makes it appear wherever the person is
    // actually looking rather than only in this process.
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]?.tool).toBe('phone');
    expect(h.asks[0]?.capability).toBe('device.command.vibrate');
    expect(h.asks[0]?.reason).toBe('confirming which phone is on the desk');
    expect(h.dispatched).toEqual(['device.command.vibrate']);
  });

  test('a refusal is an answer with the reason, and nothing reaches the phone', async () => {
    const h = harness();
    h.approve('deny');
    const result = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.camera.rear.capture', reason: 'no thanks' },
    }) as { ok: boolean; refusal: string; detail: string };

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('denied-by-person');
    expect(result.detail).toContain('not right now');
    expect(h.dispatched).toEqual([]);
  });

  test('a capture is retained by this daemon\'s store and read back byte for byte', async () => {
    const h = harness();
    h.sendBytes(true);
    const requested = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.screen.capture', reason: 'read the error on my screen' },
    }) as { ok: boolean; artifact: { artifactId: string; byteLength: number; mediaType: string } | null };

    expect(requested.ok).toBe(true);
    expect(requested.artifact?.mediaType).toBe('image/png');
    const artifactId = requested.artifact?.artifactId ?? '';

    const listed = await h.catalog.invoke('devices.artifacts.list', { ...CONTEXT, body: {} }) as {
      artifacts: readonly { artifactId: string }[];
      retained: number;
      retentionHours: number;
    };
    expect(listed.retained).toBe(1);
    expect(listed.retentionHours).toBe(24);
    expect(listed.artifacts[0]?.artifactId).toBe(artifactId);

    const read = await h.catalog.invoke('devices.artifacts.read', {
      ...CONTEXT,
      body: { artifactId },
    }) as { dataBase64: string; artifact: { byteLength: number } };
    expect(read.artifact.byteLength).toBe(CAPTURE_BYTES.byteLength);
    // A surface that is not on this host's disk gets the same bytes the phone
    // sent, which is the whole reason this verb exists.
    expect([...Buffer.from(read.dataBase64, 'base64')]).toEqual([...CAPTURE_BYTES]);
  });

  test('a durable grant given through the verb is visible and revocable in the grants surface', async () => {
    const h = harness();
    h.approve('always');
    await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'roughly where am I' },
    });

    const grants = await h.catalog.invoke('devices.grants.list', { ...CONTEXT, body: {} }) as {
      grants: readonly { capabilityId: string; nodeId: string; grantId: string }[];
    };
    expect(grants.grants.map((grant) => grant.capabilityId)).toEqual(['device.location.coarse']);

    // The second request is served by the grant rather than by asking again.
    const second = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'again' },
    }) as { authority: string };
    expect(second.authority).toBe('existing-grant');
    expect(h.asks).toHaveLength(1);

    await h.catalog.invoke('devices.grants.revoke', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse' },
    });
    const third = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'after revoking' },
    }) as { authority: string };
    expect(third.authority).toBe('confirmed-always');
    expect(h.asks).toHaveLength(2);
  });

  test('this daemon records itself as the actor, so the ledger says where the decision was made', async () => {
    const h = harness();
    h.approve('always');
    await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.clipboard.read', reason: 'paste what I copied' },
    });
    const grants = await h.catalog.invoke('devices.grants.list', { ...CONTEXT, body: {} }) as {
      grants: readonly { grantedBy: string }[];
      audit: readonly { action: string }[];
    };
    expect(grants.grants[0]?.grantedBy).toBe('operator');
    expect(grants.audit.some((entry) => entry.action === 'granted')).toBe(true);
    expect(TUI_DEVICE_ACTOR).toBe('tui:phone-tool');
  });

  test('a request the contract cannot satisfy is refused before anyone is asked', async () => {
    const h = harness();
    const missingInput = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.clipboard.write', reason: 'put this on the phone' },
    }) as { ok: boolean; refusal: string };
    const unknownNode = await h.catalog.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'not-paired', capabilityId: 'device.command.vibrate', reason: 'x' },
    }) as { ok: boolean; refusal: string };

    expect(missingInput.refusal).toBe('invalid-input');
    expect(unknownNode.refusal).toBe('node-unknown');
    expect(h.asks).toHaveLength(0);
    expect(h.dispatched).toEqual([]);
  });
});

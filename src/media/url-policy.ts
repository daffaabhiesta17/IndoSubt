import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { MediaProbeError } from './types.js';

export interface HostAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly HostAddress[]>;

export interface RemoteMediaUrlPolicyOptions {
  allowedHosts?: readonly string[];
  allowedPorts?: readonly number[];
  resolveHost?: HostResolver;
}

export interface ValidatedRemoteMediaUrl {
  url: URL;
  resolvedAddresses: readonly HostAddress[];
}

const defaultResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family as 4 | 6
  }));
};

const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback, and IPv4-compatible space
  ['::ffff:0:0', 96], // IPv4-mapped addresses
  ['64:ff9b:1::', 48], // local-use translation
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF special-purpose assignments
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 transition space
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['ff00::', 8] // multicast
] as const) {
  nonPublicIpv6.addSubnet(network, prefix, 'ipv6');
}

export class RemoteMediaUrlPolicy {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly allowedPorts: ReadonlySet<number>;
  private readonly resolveHost: HostResolver;

  constructor(options: RemoteMediaUrlPolicyOptions = {}) {
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((host) => normalizeAllowedHost(host))
    );
    this.allowedPorts = new Set(options.allowedPorts ?? [80, 443]);
    for (const port of this.allowedPorts) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid allow-listed media port: ${port}`);
      }
    }
    this.resolveHost = options.resolveHost ?? defaultResolver;
  }

  async validate(input: string): Promise<ValidatedRemoteMediaUrl> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new MediaProbeError('invalid_source', 'Remote media URL is malformed.');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new MediaProbeError('invalid_source', 'Remote media URL must use HTTP or HTTPS.');
    }
    if (url.username || url.password) {
      throw new MediaProbeError('invalid_source', 'Remote media URL must not contain credentials.');
    }
    if (url.hash) {
      throw new MediaProbeError('invalid_source', 'Remote media URL must not contain a fragment.');
    }

    const effectivePort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!this.allowedPorts.has(effectivePort)) {
      throw new MediaProbeError('forbidden_source', 'Remote media port is not allow-listed.');
    }

    const hostname = normalizeHostname(url.hostname);
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new MediaProbeError('forbidden_source', 'Remote media host is not allowed.');
    }
    if (!this.allowedHosts.has(hostname)) {
      throw new MediaProbeError('forbidden_source', 'Remote media host is not allow-listed.');
    }

    const literalFamily = isIP(hostname);
    const addresses: readonly HostAddress[] = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await this.resolve(hostname);

    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
      throw new MediaProbeError('forbidden_source', 'Remote media host resolves to a non-public address.');
    }

    return { url, resolvedAddresses: addresses };
  }

  private async resolve(hostname: string): Promise<readonly HostAddress[]> {
    try {
      return await this.resolveHost(hostname);
    } catch {
      throw new MediaProbeError('forbidden_source', 'Remote media host could not be resolved safely.');
    }
  }
}

function normalizeAllowedHost(host: string): string {
  let normalized: string;
  try {
    normalized = normalizeHostname(new URL(`http://${host}`).hostname);
  } catch {
    throw new Error(`Invalid allow-listed media host: ${host}`);
  }
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error(`Invalid allow-listed media host: ${host}`);
  }
  return normalized;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) {
    const normalized = address.split('%')[0];
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    const isGlobalUnicast = Number.isFinite(first) && (first & 0xe000) === 0x2000;
    return isGlobalUnicast && !nonPublicIpv6.check(normalized, 'ipv6');
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}



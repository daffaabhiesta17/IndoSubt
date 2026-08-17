import { describe, expect, it, vi } from 'vitest';
import { MediaProbeError } from '../src/media/types.js';
import {
  isPublicIpAddress,
  RemoteMediaUrlPolicy,
  type HostResolver
} from '../src/media/url-policy.js';

const publicResolver: HostResolver = vi.fn().mockResolvedValue([
  { address: '93.184.216.34', family: 4 }
]);

function policy(resolveHost: HostResolver = publicResolver) {
  return new RemoteMediaUrlPolicy({
    allowedHosts: ['media.example.com'],
    resolveHost
  });
}

describe('remote media URL policy', () => {
  it('accepts an allow-listed HTTP or HTTPS host resolving only to public IPs', async () => {
    const result = await policy().validate('https://media.example.com/video.mp4?token=value');
    expect(result.url.hostname).toBe('media.example.com');
    expect(result.resolvedAddresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it.each(['file:///tmp/video.mp4', 'ftp://media.example.com/video.mp4', 'data:text/plain,x'])(
    'rejects invalid protocol %s',
    async (url) => {
      await expect(policy().validate(url)).rejects.toMatchObject({ code: 'invalid_source' });
    }
  );

  it('rejects malformed URLs', async () => {
    await expect(policy().validate('not a URL')).rejects.toMatchObject({ code: 'invalid_source' });
  });

  it.each(['http://localhost/video', 'http://test.localhost/video'])(
    'rejects localhost %s',
    async (url) => {
      await expect(policy().validate(url)).rejects.toMatchObject({
        code: 'forbidden_source'
      });
    }
  );

  it('rejects ports outside the explicit allow-list', async () => {
    await expect(
      policy().validate('https://media.example.com:8080/video')
    ).rejects.toMatchObject({ code: 'forbidden_source' });
  });
  it('rejects hosts not on the explicit allow-list', async () => {
    await expect(policy().validate('https://attacker.example/video')).rejects.toMatchObject({
      code: 'forbidden_source'
    });
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1'
  ])('classifies non-public address %s as forbidden', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'classifies public address %s as public',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    }
  );

  it('rejects a hostname if any DNS result is private', async () => {
    const resolveHost: HostResolver = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ]);
    await expect(policy(resolveHost).validate('https://media.example.com/video')).rejects.toMatchObject({
      code: 'forbidden_source'
    });
  });

  it('rejects credentials and fragments', async () => {
    await expect(
      policy().validate('https://user:password@media.example.com/video')
    ).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(policy().validate('https://media.example.com/video#fragment')).rejects.toMatchObject({
      code: 'invalid_source'
    });
  });

  it('wraps DNS failures without leaking details', async () => {
    const resolveHost: HostResolver = vi.fn().mockRejectedValue(new Error('internal DNS detail'));
    await expect(policy(resolveHost).validate('https://media.example.com/video')).rejects.toEqual(
      new MediaProbeError('forbidden_source', 'Remote media host could not be resolved safely.')
    );
  });
});



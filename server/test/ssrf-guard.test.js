import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { storageService } from '../src/services/storage.service.js';
import { env } from '../src/config/env.js';

/**
 * SSRF guard tests for storageService.assertStorageFileUrl.
 *
 * The guard allows ONLY https delivery URLs from the configured Cloudinary
 * host whose first path segment matches the configured cloud name. Everything
 * else (internal IPs, other hosts, plain HTTP, other tenants) must be refused
 * with a 400 BEFORE any network access happens.
 */

// The guard fails closed when CLOUDINARY_CLOUD_NAME is unset: every URL must
// be refused regardless of shape. These tests therefore construct the
// "allowed" shape dynamically from whatever the test environment provides.
const cloud = (env.CLOUDINARY_CLOUD_NAME || '').trim();
const host = env.CLOUDINARY_HOST || 'res.cloudinary.com';

const expectReject = (fileUrl) => {
  assert.throws(
    () => storageService.assertStorageFileUrl(fileUrl),
    (err) => err.status === 400 && err instanceof Error
  );
};

describe('SSRF guard: assertStorageFileUrl', () => {
  test('rejects internal / metadata addresses', () => {
    expectReject('http://169.254.169.254/latest/meta-data/');
    expectReject('http://localhost:6333/collections');
    expectReject('http://127.0.0.1:5000/api/health');
    expectReject('http://[::1]:6333/');
    expectReject('http://192.168.1.10/admin');
  });

  test('rejects non-https schemes', () => {
    expectReject('ftp://example.com/file.pdf');
    expectReject('file:///etc/passwd');
    if (host !== 'example.com') {
      expectReject(`http://${host}/${cloud || 'x'}/raw/upload/file.pdf`);
    }
  });

  test('rejects malformed URLs', () => {
    expectReject('not a url');
    expectReject('');
    expectReject('res.cloudinary.com/no-scheme.pdf');
  });

  test('rejects hosts outside the storage allowlist', () => {
    expectReject('https://evil.example/cloud/raw/upload/file.pdf');
    if (host !== 'localhost') {
      expectReject('https://localhost/cloud/raw/upload/file.pdf');
    }
  });

  test('rejects wrong-cloud paths on the allowed host', () => {
    if (cloud) {
      expectReject(`https://${host}/some-other-cloud/raw/upload/file.pdf`);
    }
  });

  test('allows the configured storage host + cloud path', () => {
    if (!cloud) {
      // Fail-closed mode: with no cloud configured, nothing is allowed.
      expectReject(`https://${host}/any-cloud/raw/upload/file.pdf`);
      return;
    }
    // Must NOT throw:
    storageService.assertStorageFileUrl(`https://${host}/${cloud}/raw/upload/papers/file.pdf`);
  });
});

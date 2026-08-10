const {
  patchBuildGradle,
  validateApksignerOutput,
} = require('./androidReleaseSigning');

const generatedBuildGradle = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

describe('Android production release signing', () => {
  it('replaces Expo debug signing with environment-backed release signing', () => {
    const patched = patchBuildGradle(generatedBuildGradle);

    expect(patched).toContain('release {\n            def releaseStoreFile = System.getenv("ANDROID_RELEASE_STORE_FILE")');
    expect(patched).toContain('storePassword System.getenv("ANDROID_RELEASE_STORE_PASSWORD")');
    expect(patched).toContain('keyAlias System.getenv("ANDROID_RELEASE_KEY_ALIAS")');
    expect(patched).toContain('keyPassword System.getenv("ANDROID_RELEASE_KEY_PASSWORD")');
    expect(patched).toContain('signingConfig signingConfigs.release');
    expect(patched).not.toContain('release {\n            signingConfig signingConfigs.debug');
  });

  it('accepts a v2-signed non-debug APK with the pinned certificate digest', () => {
    const report = `
Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Signer #1 certificate DN: CN=Eisenhower Production, O=Eisenhower
Signer #1 certificate SHA-256 digest: ${'A'.repeat(64)}
Number of signers: 1
`;

    expect(validateApksignerOutput(report, 'a'.repeat(64))).toEqual([]);
  });

  it('rejects debug, unpinned, or non-v2 APK signatures', () => {
    const debugReport = `
Verifies
Verified using v2 scheme (APK Signature Scheme v2): false
Signer #1 certificate DN: CN=Android Debug, O=Unknown
Signer #1 certificate SHA-256 digest: 00112233
Number of signers: 1
`;

    const errors = validateApksignerOutput(debugReport, 'a'.repeat(64));

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/v2/i),
      expect.stringMatching(/debug/i),
      expect.stringMatching(/digest/i),
    ]));
  });
});

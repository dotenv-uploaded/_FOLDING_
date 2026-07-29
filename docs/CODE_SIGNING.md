# Code signing

Folding keeps signing credentials outside Git. Local development builds may remain unsigned, while Windows and
macOS release jobs use `pnpm package:signed`, which fails if a valid signing identity is unavailable.

## Startup preparation

Before applying for a certificate, decide which legal entity will appear as the publisher. Certificate authorities
normally validate the entity registration, physical address, telephone number, domain ownership, and the identity
and authority of the applicant. Requirements vary by provider and jurisdiction, so prepare current incorporation or
business-registration records and ensure public registry details are consistent.

## Windows

For an early-stage company, an organization-validation Authenticode certificate is usually the practical starting
point. Purchase it from a trusted certificate authority such as DigiCert, Sectigo, or SSL.com. Extended-validation
certificates can establish SmartScreen trust more quickly, but certificate grade and private-key delivery are
separate decisions.

Publicly trusted code-signing private keys issued since June 1, 2023 must be generated, stored, and used in a
qualifying hardware cryptographic module. This requirement applies to both organization-validation and
extended-validation certificates. Before ordering, ask the certificate authority which supported delivery model it
provides:

- **CA-managed cloud signing or cloud HSM:** best suited to hosted CI. Prefer a provider-supported API or
  electron-builder signing backend so the private key never enters GitHub Actions.
- **Hardware USB token or smart card:** use a secured, self-hosted Windows runner with the vendor driver and token
  attached. GitHub-hosted runners cannot access a physical token. Select the certificate from the Windows certificate
  store by subject name or thumbprint.
- **Compatible PKCS#12 material:** use only when the certificate authority explicitly supplies a compliant signing
  product that supports this workflow. Do not export or copy a non-exportable hardware-backed private key.
- **Azure Trusted Signing:** use Microsoft's cloud signing service when the company and Azure subscription satisfy
  its eligibility and regional requirements.

The checked-in GitHub Actions workflow currently supports the compatible PKCS#12 path. Add these repository secrets
only if the selected certificate provider documents that method:

- `WIN_CSC_LINK`: base64-encoded `.pfx`/`.p12` content or a secured downloadable certificate URL.
- `WIN_CSC_KEY_PASSWORD`: the PKCS#12 password.

Run the `Desktop installers` workflow after provisioning the secrets. The signed build uses `forceCodeSigning`, so
missing or invalid credentials stop the release instead of silently producing an unsigned installer.

For a local Windows signing test:

```powershell
$env:WIN_CSC_LINK = 'C:\secure\folding-code-signing.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<certificate-password>'
pnpm package:signed
Get-AuthenticodeSignature .\release\Folding-0.1.0-win-x64.exe
```

Do not put the password in `.env`, workflow YAML, shell history, an issue, or a committed file.

For a hardware token, install the provider middleware and certificate on a secured self-hosted Windows runner, then
configure electron-builder with the CA's required `signtool`, HSM, or PKCS#11 method. For Azure Trusted Signing,
configure electron-builder's Azure signing backend and workload identity. These provider-specific settings must be
added only after selecting the signing product; do not combine multiple signing methods in one build.

## macOS

Windows certificates cannot sign macOS applications. Join the Apple Developer Program under the company entity,
create a `Developer ID Application` certificate, export it as a password-protected `.p12`, and add:

- `MAC_CSC_LINK`: base64-encoded `.p12`.
- `MAC_CSC_KEY_PASSWORD`: `.p12` password.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization.
- `APPLE_TEAM_ID`: ten-character Apple Developer team identifier.

The macOS package uses the hardened runtime and notarization. Both signing and notarization must succeed before a
public DMG is distributed.

## Verification

Windows:

```powershell
Get-AuthenticodeSignature .\release\Folding-0.1.0-win-x64.exe
```

macOS:

```bash
codesign --verify --deep --strict --verbose=2 Folding.app
spctl --assess --type execute --verbose=4 Folding.app
xcrun stapler validate Folding.app
```

Certificate expiration does not invalidate correctly timestamped Windows signatures, but renew the certificate
before expiry so new releases remain signable. Restrict secret access, enable audit logs, and revoke the certificate
immediately if the private key may have been exposed.

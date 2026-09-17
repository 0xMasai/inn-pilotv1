# Code signing the InnPilot installer

The Windows installer is currently **unsigned**. On any machine other than a
build box, Windows SmartScreen shows *"Windows protected your PC"* and the user
has to click **More info → Run anyway** to install.

Only a certificate issued by a public CA after identity validation removes that
prompt. A self-signed certificate does not — it changes the signature status but
SmartScreen still warns on every machine that does not trust your root.

The build is already wired for signing. Once you have a certificate, no code
change is needed: electron-builder picks the certificate up from environment
variables.

## 1. Buy a certificate

| Type | Cost/yr | SmartScreen behaviour |
| --- | --- | --- |
| **OV** (Organization Validation) | ~$200–300 | Warning persists until the cert builds download reputation (days–weeks) |
| **EV** (Extended Validation) | ~$350–500 | Trusted immediately, no reputation period |

Common CAs: DigiCert, Sectigo, SSL.com, GlobalSign.

You will need business documentation (registration, verifiable phone number) for
either type. EV certificates ship on a hardware token or via a cloud HSM — since
June 2023 all new code-signing keys must live in FIPS-140-2 hardware, so a plain
`.pfx` file download is only offered for some OV products.

## 2. Sign a build

### If you have a `.pfx` / `.p12` file

```powershell
$env:CSC_LINK        = "C:\path\to\innpilot-cert.pfx"   # or a base64 string / https URL
$env:CSC_KEY_PASSWORD = "<certificate password>"
npm run dist
```

`CSC_LINK` accepts an absolute path, an `https://` URL, or the base64-encoded
contents of the file. Use `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` instead if you
ever need different certificates per platform.

### If the certificate is in the Windows certificate store (EV token)

Add the subject name to `build.win.signtoolOptions` in `package.json`:

```json
"signtoolOptions": {
  "certificateSubjectName": "Masai Labs",
  "signingHashAlgorithms": ["sha256"],
  "rfc3161TimeStampServer": "http://timestamp.digicert.com"
}
```

Then plug in the token and run `npm run dist`. signtool prompts for the token PIN
unless the vendor's tooling caches it.

### Azure Trusted Signing

electron-builder 26 also supports `build.win.azureSignOptions`, which is usually
cheaper than an EV cert and needs no hardware token. It cannot be combined with
`signtoolOptions` — remove that block if you go this route.

## 3. What is already configured

`build.win.signtoolOptions` in `package.json` sets:

- `signingHashAlgorithms: ["sha256"]` — SHA-1 is rejected by modern Windows.
- `rfc3161TimeStampServer` — timestamps the signature so it stays valid after the
  certificate expires. Without it, every installer you ever shipped starts
  failing verification on the certificate's expiry date.

These are inert while no certificate is supplied; the build simply produces an
unsigned installer.

## 4. Verify a signed build

```powershell
Get-AuthenticodeSignature ".\release\InnPilot-Setup-1.0.0.exe" |
  Select-Object Status, SignerCertificate, TimeStamperCertificate
```

`Status` must be `Valid`. `NotSigned` means the certificate was not picked up —
check that `CSC_LINK` was set in the *same* shell that ran the build.

## Never commit the certificate

Keep the `.pfx` and its password out of the repository. `*.pfx` and `*.p12` are
in `.gitignore`. In CI, store `CSC_LINK` (base64) and `CSC_KEY_PASSWORD` as
encrypted secrets.

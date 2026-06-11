const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = process.env.R2_PUBLIC_URL;
const VERSION = process.env.RELEASE_VERSION;
const RELEASE_TAG = process.env.RELEASE_TAG || `v${VERSION}`;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY;

async function fetchExistingReleases() {
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: 'releases.json',
      })
    );
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      console.log('No existing releases.json found, creating new one');
      return { latestVersion: null, releases: [] };
    }
    throw error;
  }
}

async function uploadFile(localPath, r2Key, contentType) {
  const fileBuffer = fs.readFileSync(localPath);
  const stats = fs.statSync(localPath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );

  console.log(`Uploaded: ${r2Key} (${stats.size} bytes)`);
  return stats.size;
}

function findArtifacts(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  return files.filter((f) => pattern.test(f)).map((f) => path.join(dir, f));
}

async function checkUrlAccessible(url, maxRetries = 10, initialDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const request = https.get(url, { timeout: 10000 }, (response) => {
          const statusCode = response.statusCode;

          // Follow redirects
          if (
            statusCode === 302 ||
            statusCode === 301 ||
            statusCode === 307 ||
            statusCode === 308
          ) {
            const redirectUrl = response.headers.location;
            response.destroy();
            if (!redirectUrl) {
              resolve({
                accessible: false,
                statusCode,
                error: 'Redirect without location header',
              });
              return;
            }
            // Follow the redirect URL
            return https
              .get(redirectUrl, { timeout: 10000 }, (redirectResponse) => {
                const redirectStatus = redirectResponse.statusCode;
                const contentType = redirectResponse.headers['content-type'] || '';
                // Check if it's actually a file (zip/tar.gz) and not HTML
                const isFile =
                  contentType.includes('application/zip') ||
                  contentType.includes('application/gzip') ||
                  contentType.includes('application/x-gzip') ||
                  contentType.includes('application/x-tar') ||
                  redirectUrl.includes('.zip') ||
                  redirectUrl.includes('.tar.gz');
                const isGood = redirectStatus >= 200 && redirectStatus < 300 && isFile;
                redirectResponse.destroy();
                resolve({
                  accessible: isGood,
                  statusCode: redirectStatus,
                  finalUrl: redirectUrl,
                  contentType,
                });
              })
              .on('error', (error) => {
                resolve({
                  accessible: false,
                  statusCode,
                  error: error.message,
                });
              })
              .on('timeout', function () {
                this.destroy();
                resolve({
                  accessible: false,
                  statusCode,
                  error: 'Timeout following redirect',
                });
              });
          }

          // Check if status is good (200-299 range) and it's actually a file
          const contentType = response.headers['content-type'] || '';
          const isFile =
            contentType.includes('application/zip') ||
            contentType.includes('application/gzip') ||
            contentType.includes('application/x-gzip') ||
            contentType.includes('application/x-tar') ||
            url.includes('.zip') ||
            url.includes('.tar.gz');
          const isGood = statusCode >= 200 && statusCode < 300 && isFile;
          response.destroy();
          resolve({ accessible: isGood, statusCode, contentType });
        });

        request.on('error', (error) => {
          resolve({
            accessible: false,
            statusCode: null,
            error: error.message,
          });
        });

        request.on('timeout', () => {
          request.destroy();
          resolve({
            accessible: false,
            statusCode: null,
            error: 'Request timeout',
          });
        });
      });

      if (result.accessible) {
        if (attempt > 0) {
          console.log(
            `✓ URL ${url} is now accessible after ${attempt} retries (status: ${result.statusCode})`
          );
        } else {
          console.log(`✓ URL ${url} is accessible (status: ${result.statusCode})`);
        }
        return result.finalUrl || url; // Return the final URL (after redirects) if available
      } else {
        const errorMsg = result.error ? ` - ${result.error}` : '';
        const statusMsg = result.statusCode ? ` (status: ${result.statusCode})` : '';
        const contentTypeMsg = result.contentType ? ` [content-type: ${result.contentType}]` : '';
        console.log(`✗ URL ${url} not accessible${statusMsg}${contentTypeMsg}${errorMsg}`);
      }
    } catch (error) {
      console.log(`✗ URL ${url} check failed: ${error.message}`);
    }

    if (attempt < maxRetries - 1) {
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(`  Retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`URL ${url} is not accessible after ${maxRetries} attempts`);
}

async function downloadFromGitHub(url, outputPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 30000 }, (response) => {
      const statusCode = response.statusCode;

      // Follow redirects (all redirect types)
      if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
        const redirectUrl = response.headers.location;
        response.destroy();
        if (!redirectUrl) {
          reject(new Error(`Redirect without location header for ${url}`));
          return;
        }
        // Resolve relative redirects
        const finalRedirectUrl = redirectUrl.startsWith('http')
          ? redirectUrl
          : new URL(redirectUrl, url).href;
        console.log(`  Following redirect: ${finalRedirectUrl}`);
        return downloadFromGitHub(finalRedirectUrl, outputPath).then(resolve).catch(reject);
      }

      if (statusCode !== 200) {
        response.destroy();
        reject(new Error(`Failed to download ${url}: ${statusCode} ${response.statusMessage}`));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', (error) => {
        response.destroy();
        reject(error);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Request timeout for ${url}`));
    });
  });
}

async function main() {
  const artifactsDir = 'artifacts';
  const tempDir = path.join(artifactsDir, 'temp');

  // Create temp directory for downloaded GitHub archives
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Download source archives from GitHub
  const githubZipUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${RELEASE_TAG}.zip`;
  const githubTarGzUrl = `https://github.com/${GITHUB_REPO}/archive/refs/tags/${RELEASE_TAG}.tar.gz`;

  const sourceZipPath = path.join(tempDir, `automaker-${VERSION}.zip`);
  const sourceTarGzPath = path.join(tempDir, `automaker-${VERSION}.tar.gz`);

  console.log(`Waiting for source archives to be available on GitHub...`);
  console.log(`  ZIP: ${githubZipUrl}`);
  console.log(`  TAR.GZ: ${githubTarGzUrl}`);

  // Wait for archives to be accessible with exponential backoff
  // This returns the final URL after following redirects
  const finalZipUrl = await checkUrlAccessible(githubZipUrl);
  const finalTarGzUrl = await checkUrlAccessible(githubTarGzUrl);

  console.log(`Downloading source archives from GitHub...`);
  await downloadFromGitHub(finalZipUrl, sourceZipPath);
  await downloadFromGitHub(finalTarGzUrl, sourceTarGzPath);

  console.log(`Downloaded source archives successfully`);

  // Find all artifacts
  const artifacts = {
    windows: findArtifacts(path.join(artifactsDir, 'windows-builds'), /\.exe$/),
    macos: findArtifacts(path.join(artifactsDir, 'macos-builds'), /-x64\.dmg$/),
    macosArm: findArtifacts(path.join(artifactsDir, 'macos-builds'), /-arm64\.dmg$/),
    linux: findArtifacts(path.join(artifactsDir, 'linux-builds'), /\.AppImage$/),
    sourceZip: [sourceZipPath],
    sourceTarGz: [sourceTarGzPath],
  };

  console.log('Found artifacts:');
  for (const [platform, files] of Object.entries(artifacts)) {
    console.log(
      `  ${platform}: ${files.length > 0 ? files.map((f) => path.basename(f)).join(', ') : 'none'}`
    );
  }

  // Upload each artifact to R2
  const assets = {};
  const contentTypes = {
    windows: 'application/x-msdownload',
    macos: 'application/x-apple-diskimage',
    macosArm: 'application/x-apple-diskimage',
    linux: 'application/x-executable',
    sourceZip: 'application/zip',
    sourceTarGz: 'application/gzip',
  };

  for (const [platform, files] of Object.entries(artifacts)) {
    if (files.length === 0) {
      console.warn(`Warning: No artifact found for ${platform}`);
      continue;
    }

    // Use the first matching file for each platform
    const localPath = files[0];
    const filename = path.basename(localPath);
    const r2Key = `releases/${VERSION}/${filename}`;
    const size = await uploadFile(localPath, r2Key, contentTypes[platform]);

    assets[platform] = {
      url: `${PUBLIC_URL}/releases/${VERSION}/${filename}`,
      filename,
      size,
      arch:
        platform === 'macosArm'
          ? 'arm64'
          : platform === 'sourceZip' || platform === 'sourceTarGz'
            ? 'source'
            : 'x64',
    };
  }

  // Fetch and update releases.json
  const releasesData = await fetchExistingReleases();

  const newRelease = {
    version: VERSION,
    date: new Date().toISOString(),
    assets,
    githubReleaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/${RELEASE_TAG}`,
  };

  // Remove existing entry for this version if re-running
  releasesData.releases = releasesData.releases.filter((r) => r.version !== VERSION);

  // Prepend new release
  releasesData.releases.unshift(newRelease);
  releasesData.latestVersion = VERSION;

  // Upload updated releases.json
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'releases.json',
      Body: JSON.stringify(releasesData, null, 2),
      ContentType: 'application/json',
      CacheControl: 'public, max-age=60',
    })
  );

  console.log('Successfully updated releases.json');
  console.log(`Latest version: ${VERSION}`);
  console.log(`Total releases: ${releasesData.releases.length}`);
}

main().catch((err) => {
  console.error('Failed to upload to R2:', err);
  process.exit(1);
});

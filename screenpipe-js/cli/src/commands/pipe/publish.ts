import fs from "fs";
import path from "path";
import { Credentials } from "../../utils/credentials";
import { API_BASE_URL } from "../../constants";
import archiver from "archiver";
import crypto from "crypto";
import ignore from "ignore";
import { colors, symbols } from "../../utils/colors";
import { Command } from "commander";
import { logger } from "../components/commands/add/utils/logger";

interface ProjectFiles {
  required: string[];
  optional: string[];
}

const NEXTJS_FILES: ProjectFiles = {
  required: ["package.json", ".next"],
  optional: [
    "package-lock.json",
    "bun.lockb",
    "next.config.js",
    "next.config.mjs",
  ],
};

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB limit

async function archiveNextJsProject(archive: archiver.Archiver): Promise<void> {
  const { required, optional } = NEXTJS_FILES;

  // Verify required files exist
  const missingFiles = required.filter((file) => !fs.existsSync(file));
  if (missingFiles.length > 0) {
    throw new Error(
      `Required files not found: ${missingFiles.join(", ")}. ` +
        "Make sure you're in the correct directory and the project is built."
    );
  }

  // Archive required files
  for (const file of required) {
    if (file === ".next") {
      archive.directory(".next", ".next", (entry) => {
        return entry.name.startsWith(".next/cache/") ? false : entry;
      });
    } else {
      archive.file(file, { name: file });
    }
  }

  // Archive optional files if they exist
  optional
    .filter((file) => fs.existsSync(file))
    .forEach((file) => {
      archive.file(file, { name: file });
    });
}

function archiveStandardProject(
  archive: archiver.Archiver,
  ig: ReturnType<typeof ignore>
): void {
  archive.glob("**/*", {
    ignore: [".git/**", "node_modules/**", ".next/cache/**"],
    dot: true,
    nodir: false,
    mark: true,
  });
}

async function retryFetch(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  baseDelay = 1000
): Promise<Response> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;

      // If it's the last attempt, throw the error
      if (attempt === maxRetries) {
        throw new Error(
          `Failed after ${maxRetries} attempts: ${await response.text()}`
        );
      }
    } catch (error) {
      if (attempt === maxRetries) throw error;
    }

    // Exponential backoff delay
    const delay = baseDelay * Math.pow(2, attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Retry failed"); // Fallback error
}

export const publishCommand = new Command('publish')
  .description('publish or update a pipe to the store')
  .requiredOption('-n, --name <name>', 'name of the pipe')
  .option('-v, --verbose', 'enable verbose logging', false)
  .action(async (opts) => {
    try {
      if (opts.verbose) {
        console.log(colors.dim(`${symbols.arrow} starting publish command...`));
      }

      const apiKey = Credentials.getApiKey();
      if (!apiKey) {
        console.error(
          colors.error(
            `${
              symbols.error
            } not logged in. please login first using ${colors.highlight(
              "screenpipe login"
            )}`
          )
        );
        process.exit(1);
      }

      if (opts.verbose) {
        console.log(colors.dim(`${symbols.arrow} reading package.json...`));
      }
      // Read package.json
      let packageJson: { name: string; version: string };
      try {
        packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
      } catch (error) {
        console.error(
          colors.error(
            `${symbols.error} failed to read package.json. Make sure you're in the correct directory.`
          )
        );
        process.exit(1);
      }

      if (!packageJson.name || !packageJson.version) {
        console.error(
          colors.error(
            `${symbols.error} package name and version are required in package.json`
          )
        );
        process.exit(1);
      }

      logger.info(
        colors.info(
          `\n${symbols.info} publishing ${colors.highlight(
            packageJson.name
          )} v${packageJson.version}...`
        )
      );
      logger.log(colors.dim(`${symbols.arrow} creating package archive...`));

      // Create temporary zip file
      const zipPath = path.join(
        process.cwd(),
        `${packageJson.name}-${packageJson.version}.zip`
      );
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      // Setup .gitignore rules
      const ig = ignore();
      if (fs.existsSync(".gitignore")) {
        ig.add(fs.readFileSync(".gitignore").toString());
      }

      // Check if it's a Next.js project by looking for next.config.js or next.config.mjs
      const isNextProject =
        fs.existsSync("next.config.js") ||
        fs.existsSync("next.config.mjs") ||
        fs.existsSync("next.config.ts");

      // Create zip file
      archive.pipe(output);

      if (isNextProject) {
        await archiveNextJsProject(archive);
      } else {
        archiveStandardProject(archive, ig);
      }

      await new Promise((resolve, reject) => {
        output.on("close", resolve);
        archive.on("error", reject);
        archive.finalize();
      });

      if (opts.verbose) {
        console.log(
          colors.dim(
            `${symbols.arrow} detected project type: ${
              isNextProject ? "nextjs" : "standard"
            }`
          )
        );
        console.log(
          colors.dim(`${symbols.arrow} starting archive creation...`)
        );
      }

      // Calculate file hash
      const fileBuffer = fs.readFileSync(zipPath);
      const hashSum = crypto.createHash("sha256");
      hashSum.update(fileBuffer);
      const fileHash = hashSum.digest("hex");
      const fileSize = fs.statSync(zipPath).size;

      if (fileSize > MAX_FILE_SIZE) {
        console.error(
          colors.error(
            `${symbols.error} Package size (${(fileSize / 1024 / 1024).toFixed(
              2
            )}MB) exceeds maximum allowed size (${
              MAX_FILE_SIZE / 1024 / 1024
            }MB)`
          )
        );
        fs.unlinkSync(zipPath); // Clean up the zip file
        process.exit(1);
      }

      let description = null;
      try {
        const readmeContent = fs.readFileSync("README.md", "utf-8");
        if (readmeContent) {
          description = readmeContent;
        }
      } catch (error) {
        console.log(
          colors.dim(
            `${symbols.arrow} No README.md found, required for description`
          )
        );
      }
      if (!description) {
        console.error(colors.error(`${symbols.error} Description is required`));
        process.exit(1);
      }

      if (opts.verbose) {
        console.log(colors.dim(`${symbols.arrow} calculating file hash...`));
      }

      // Replace the upload section with this:
      try {
        // First get the signed URL
        console.log(colors.dim(`${symbols.arrow} Getting upload URL...`));

        const urlResponse = await fetch(`${API_BASE_URL}/api/plugins/publish`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: opts.name,
            version: packageJson.version,
            fileSize,
            fileHash,
            description,
          }),
        });

        if (!urlResponse.ok) {
          throw new Error(
            `Failed to get upload URL: ${await urlResponse.text()}`
          );
        }

        const { uploadUrl, path } = await urlResponse.json();

        // Upload directly to Supabase
        logger.log(colors.dim(`${symbols.arrow} uploading to storage...`));
        const uploadResponse = await retryFetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "application/zip",
          },
          body: fileBuffer,
        });

        if (!uploadResponse.ok) {
          const text = await uploadResponse.text();
          throw new Error(`Failed to upload file to storage: ${text}`);
        }

        // Notify server that upload is complete
        logger.log(colors.dim(`${symbols.arrow} finalizing upload...`));
        const finalizeResponse = await fetch(
          `${API_BASE_URL}/api/plugins/publish/finalize`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: opts.name,
              version: packageJson.version,
              fileHash,
              storagePath: path,
              description,
              fileSize,
            }),
          }
        );

        if (!finalizeResponse.ok) {
          const text = await finalizeResponse.text();
          throw new Error(`Failed to finalize upload: ${text}`);
        }

        const data = await finalizeResponse.json();

        // Success messages
        logger.success(`\n${symbols.success} successfully published plugin!`)
        
        console.log(
          colors.listItem(`${colors.label("name")} ${packageJson.name}`)
        );
        console.log(
          colors.listItem(`${colors.label("version")} ${packageJson.version}`)
        );
        console.log(
          colors.listItem(
            `${colors.label("size")} ${(fileSize / 1024).toFixed(2)} KB`
          )
        );

        if (data.message) {
          logger.info(`\n${symbols.info} ${data.message}`);
        }

        // Cleanup zip file
        fs.unlinkSync(zipPath);
        if (opts.verbose) {
          logger.log(
            colors.dim(`${symbols.arrow} cleaned up temporary zip file`)
          );
        }
      } catch (error) {
        // Cleanup zip file even if upload failed
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
          if (opts.verbose) {
            logger.log(
              colors.dim(`${symbols.arrow} cleaned up temporary zip file`)
            );
          }
        }

        if (error instanceof Error) {
          console.error(
            colors.error(
              `\n${symbols.error} Publishing failed: ${error.message}`
            )
          );
        }
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(
          colors.error(`\n${symbols.error} Publishing failed: ${error.message}`)
        );
      } else {
        console.error(
          colors.error(
            `\n${symbols.error} Publishing failed with unexpected error`
          )
        );
      }
      process.exit(1);
    }
  })

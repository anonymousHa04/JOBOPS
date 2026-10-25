import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const JSON_NOTE = "Return the result as JSON with exactly this structure.";

export function loadPrompt(name: "one-time-parser" | "parse-job-descripton" | "select-and-tailor"): { template: string; version: string } {
    const promptsDir = process.env.JOBOPS_PROMPTS_DIR ?? "requirements";
    const filePath = path.join(promptsDir, `${name}.txt`);

    if (!fs.existsSync(filePath)) {
        throw new Error(`Prompt file not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const version = crypto.createHash('sha256').update(fileContent).digest('hex').substring(0, 8);

    return { template: fileContent, version };
}

export function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\[([^\]]+)\]/g, (match, key) => {
        if (values.hasOwnProperty(key)) {
            return values[key];
        } else {
            throw new Error(`Placeholder [${key}] not found in template`);
        }
    });
}

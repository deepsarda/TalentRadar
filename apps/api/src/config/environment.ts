import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_DIST_DIR: z.string().optional(),
  MONGODB_URI: z.string().startsWith("mongodb").optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  RUN_WORKER_IN_API: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return EnvironmentSchema.parse(source);
}

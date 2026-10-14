import { z } from "zod";

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_DIST_DIR: z.string().optional(),
    APP_ORIGIN: z.url().optional(),
    RENDER_EXTERNAL_URL: z.url().optional(),
    MONGODB_URI: z.string().startsWith("mongodb").optional(),
    SESSION_SECRET: z.string().min(32).optional(),
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default("gemini-3.1-flash-lite"),
    MODEL_DATA_POLICY: z.enum(["synthetic_only", "paid_private"]).default("synthetic_only"),
    REPO_TOKEN_BUDGET: z.coerce.number().int().min(4000).max(20000).default(12000),
    // Free-tier defaults; your project's real limits are shown in AI Studio.
    GEMINI_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).default(15),
    GEMINI_TOKENS_PER_MINUTE: z.coerce.number().int().min(1000).default(250_000),
    GITHUB_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).default(5000),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3).default("TalentRadar <onboarding@resend.dev>"),
    RUN_WORKER_IN_API: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== "production") return;

    const required = [
      ["MONGODB_URI", environment.MONGODB_URI],
      ["SESSION_SECRET", environment.SESSION_SECRET],
      ["GITHUB_CLIENT_ID", environment.GITHUB_CLIENT_ID],
      ["GITHUB_CLIENT_SECRET", environment.GITHUB_CLIENT_SECRET],
      ["GEMINI_API_KEY", environment.GEMINI_API_KEY],
    ] as const;

    for (const [name, value] of required) {
      if (!value) {
        context.addIssue({
          code: "custom",
          message: `${name} is required in production`,
          path: [name],
        });
      }
    }

    if (!environment.APP_ORIGIN && !environment.RENDER_EXTERNAL_URL) {
      context.addIssue({
        code: "custom",
        message: "APP_ORIGIN or RENDER_EXTERNAL_URL is required in production",
        path: ["APP_ORIGIN"],
      });
    }
  });

export type Environment = z.infer<typeof EnvironmentSchema>;

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return EnvironmentSchema.parse(source);
}

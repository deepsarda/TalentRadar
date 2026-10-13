import { z } from "zod";
import taxonomyData from "./taxonomy.json" with { type: "json" };

const DetectionRulesSchema = z.record(z.string(), z.array(z.string()));

const TechnologySchema = z.object({
  label: z.string().min(1),
  aliases: z.array(z.string()),
  domains: z.array(z.string()).min(1),
  detect: DetectionRulesSchema,
});

export const TaxonomySchema = z.object({
  version: z.string().min(1),
  domains: z.record(
    z.string(),
    z.object({
      label: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
  technologies: z.record(z.string(), TechnologySchema),
});

export type Taxonomy = z.infer<typeof TaxonomySchema>;

export const taxonomy = TaxonomySchema.parse(taxonomyData);

export const taxonomyIds = [
  ...Object.keys(taxonomy.domains),
  ...Object.keys(taxonomy.technologies),
] as const;

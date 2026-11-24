# Recipe-izer 9000

Offline-first PWA for saving recipes. Each recipe has a name, a base number of portions, a portion size, ingredients and assembly steps. On any recipe, change the portion count and every ingredient amount scales (shown as kitchen fractions like ½ and ⅓; metric amounts are rounded).

Ingredient lines that start with an amount (`2`, `1/2`, `1 1/2`, `½`, `0.75`, `2-3`) scale. Lines without one ("Salt to taste") stay as written. A line ending in `:` is a section heading.

**Pantry**: enter each ingredient once with what you pay (e.g. $5.99 for 1 lb) and its label nutrition facts (e.g. per 100 g: kcal, protein, carbs, fat, fiber, sugar, sodium). Recipe lines are matched to pantry items by name (or alias), units are converted (g/kg/oz/lb, tsp/tbsp/cup/ml/l, and count units like each/clove/can), and each recipe shows:

- Nutrition per portion and for the chosen number of portions
- Ingredient cost, optional other costs (packaging, labor), total cost per portion and per batch
- Sale price per batch (batch = base portions), profit, margin and food-cost %
- A per-ingredient breakdown that flags unmatched items or units that can't be converted. Volume-to-weight needs the pantry item's "1 cup weighs (g)"

**USDA lookup**: on a pantry item, "Look up nutrition (USDA)" searches [FoodData Central](https://fdc.nal.usda.gov/) and fills in nutrition per 100 g, plus the 1 cup / 1 each weights when USDA has them. It needs internet. It uses the shared `DEMO_KEY` (a few lookups an hour) unless you paste your own free key from https://fdc.nal.usda.gov/api-key-signup on the Backup tab. The key is stored only in that browser.

Data stays on the device (IndexedDB). Export/import JSON for backup.

Static site, no build step. Serve the folder over HTTPS (or `localhost`) and use "Add to Home Screen".

import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Moderation is reached from the inline panel. The published command list
  // should expose the two discoverable entry points, /start and /help.
  await setDefaultCommands(bot);
  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

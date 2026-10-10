import { BytecutError } from "../core/errors.js";

/**
 * citty's runMain prints a stack for anything a command throws, but expected user errors must
 * not (§7). Wrapping `run` here turns a BytecutError into one clean line and exit code 1.
 */
export function guarded<Context>(run: (context: Context) => Promise<void>) {
  return async (context: Context): Promise<void> => {
    try {
      await run(context);
    } catch (error) {
      if (!(error instanceof BytecutError)) throw error;
      console.error(`bytecut: ${error.message} [${error.code}]`);
      process.exitCode = 1;
    }
  };
}

import { drizzle } from 'drizzle-orm/d1';
import { users, userAuthProviders } from '../src/db/schema';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';

// This script assumes it's run in an environment where process.env.DB is available
// (e.g., via wrangler exec or similar that provides Cloudflare bindings)
// If not, you'll need to configure D1 access differently.

async function main() {
  if (!process.env.DB) {
    console.error('Error: DB binding not found. Ensure process.env.DB is available.');
    console.error(
      'This script might need to be run with wrangler, e.g., `npx wrangler d1 execute <YOUR_DB_NAME> --file=./scripts/backfill-local-auth-providers.ts` or `npx wrangler dev --persist --local scripts/backfill-local-auth-providers.ts` (if adapted to be callable)',
    );
    process.exit(1);
  }

  // @ts-ignore - Assuming DB is a D1Database binding
  const db = drizzle(process.env.DB);

  console.log('Starting backfill for local auth providers...');

  try {
    const allUsers = await db.select().from(users).all();

    if (allUsers.length === 0) {
      console.log('No users found to backfill. Exiting.');
      return;
    }

    console.log(`Found ${allUsers.length} users to process.`);

    const batchSize = 50; // Adjust batch size as needed
    let processedCount = 0;

    for (let i = 0; i < allUsers.length; i += batchSize) {
      const batch = allUsers.slice(i, i + batchSize);
      const newAuthProviders: (typeof userAuthProviders.$inferInsert)[] = [];

      for (const user of batch) {
        // Check if a 'local' provider already exists for this user to avoid duplicates
        const existingProvider = await db
          .select()
          .from(userAuthProviders)
          .where(eq(userAuthProviders.userId, user.id) && eq(userAuthProviders.provider, 'local'))
          .limit(1)
          .get(); // .get() for D1 single row

        if (existingProvider) {
          console.log(
            `User ${user.id} (${user.email}) already has a 'local' auth provider. Skipping.`,
          );
          continue;
        }

        newAuthProviders.push({
          id: uuidv4(),
          userId: user.id,
          provider: 'local',
          providerUserId: user.email, // As per plan: user's email for local
          email: user.email,
          linkedAt: new Date(),
        });
      }

      if (newAuthProviders.length > 0) {
        await db.insert(userAuthProviders).values(newAuthProviders).execute();
        processedCount += newAuthProviders.length;
        console.log(
          `Inserted ${newAuthProviders.length} local auth providers. Total processed: ${processedCount}`,
        );
      } else {
        console.log(
          `Batch from index ${i} had no new providers to insert (all might have been skipped).`,
        );
      }
    }

    console.log('Backfill completed successfully.');
    console.log(
      `Total local auth providers created or verified: ${processedCount} (out of ${allUsers.length} users).`,
    );
  } catch (error) {
    console.error('Error during backfill process:', error);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error in main:', err);
  process.exit(1);
});

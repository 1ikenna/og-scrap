const { MongoClient } = require("mongodb");
require ("dotenv").config();
// Use environment variable for the database URI for security

const uri = process.env.MONGODB_URI
if (!uri) {
  throw new Error("MONGODB_URI environment variable not set.");
}

let client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

let db; // This variable will hold the database instance once connected

/**
 * Connects to the MongoDB database. Should be called once at application startup.
 */
async function initializeDatabase() {
  try {
    await client.connect();
    db = client.db("predoc");

    // Create indexes for better query performance
    await createIndexes();
    console.log("✅ Successfully connected to MongoDB Atlas!");
  } catch (error) {
    console.error("⛔ Error connecting to MongoDB Atlas:", error);
    process.exit(1);
  }
}

/**
 * Creates necessary indexes for optimal query performance
 */
async function createIndexes() {
  try {
    let predoc_Collection = db.collection("predoc-scholarships");

    // Create indexes in parallel for better performance
    await Promise.all([
      predoc_Collection.createIndex({ body: 1 }, { background: true }),
        predoc_Collection.createIndex({ deadline: 1 }, { background: true }),
        predoc_Collection.createIndex({ app_link: 1 }, { unique: true, background: true }),
    ]);

    console.log("✅ Database indexing configuration completed");
    return;
    // For Posted-Jobs, we'll create the index when the collection is first used
    // This is handled in addDocumentToPostedDb function

  } catch (error) {
    console.error("⛔ Error configuring indexes:", error);
    // Non-critical error, don't throw
    console.log("ℹ️ Application will continue without optimal indexes");
  }
}

/**
 * Closes the MongoDB connection. Should be called once during application shutdown.
 */
async function closeDatabase() {
  try {
    await client.close();
    console.log("🔌 MongoDB connection closed.");
  } catch (error) {
    console.error("⛔ Error closing MongoDB connection:", error);
    process.exit(1);
  }
}

async function storePosts(postsArr) {
  const posts = Array.isArray(postsArr) ? postsArr : [postsArr];

  if (posts.length === 0) {
    return {
      success: true,
      message: "No posts to process",
      inserted: 0,
      duplicates: 0,
      errors: 0
    };
  }

  try {
    const result = await db.collection("predoc-scholarships").insertMany(posts, { ordered: false });

    return {
      success: true,
      message: `Processed ${posts.length} scholar post(s)`,
      inserted: result.insertedCount,
      duplicates: 0,
      errors: 0,
    };

  } catch (error) {
    // If the error is a bulk write error (some succeeded, some failed)
    if (error.name === 'MongoBulkWriteError' || error.result) {
      const inserted = error.result.insertedCount;
      const duplicateCount = error.writeErrors?.filter(err => err.code === 11000).length || 0;
      const otherErrors = (error.writeErrors?.length || 0) - duplicateCount;

      return {
        success: true,
        message: `Processed ${posts.length} scholar post(s) with partial successes`,
        inserted: inserted,
        duplicates: duplicateCount,
        errors: otherErrors,
      };
    }

    // Handle complete system/connection failures
    console.error("Critical error in storage operation:", error.message);
    return {
      success: false,
      message: "Failed to process jobs",
      error: error.message,
      attempted: posts.length,
    };
  }
};

async function checkPostsCount() {
  try {
    // Get collection from the shared 'db' instance
    let sa_Collection = db.collection("predoc-scholarships");

    // Use estimatedDocumentCount for better performance on large collections
    let count = await sa_Collection.estimatedDocumentCount();

    if(count > 10000) {
      console.log(`🗑️ Posted-Jobs collection has ~${count} documents. Deleting...`);

      let result = await sa_Collection.deleteMany({}, {
        writeConcern: { w: 1, j: false }
      });

      console.log(`✅ Deleted ${result.deletedCount} documents from Posted-Jobs.`);
      sa_Collection = null;
    } else {
      console.log (`Documents are within the target count threshold (10,000 docs)\ncurrent count: `, count)
    }

  } catch (error) {
    console.error("⛔ Error managing Posted-Jobs collection:", error.message);
    process.exit(1);
  }
};




module.exports = {
  initializeDatabase,
  closeDatabase,
  storePosts,
  checkPostsCount
};
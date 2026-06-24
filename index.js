const cron = require("node-cron");

const {base_scraper} = require("./scrapers/scholarships-future/sft-main.js");
const {sa_base_scraper} = require("./scrapers/scholarships-aid/sa-main.js");
const {get_jobs_ac_data} = require("./scrapers/jobs-ac/jobs-ac-main.js");
const {scrap_predoc} = require("./scrapers/predoc/predoc-main.js");
const {academy} = require("./scrapers/academy-pos/academy-main.js");
const { getNigerianTime, formatNigerianTime } = require("./utils/dateHelpers.js");
const http = require("http");
// --- Core Application Logic ---

let isJobRunning = false;
// --- HTTP Server for Health Checks ---
const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    const serverTime = formatNigerianTime();
    const html = `
      <div style="font-family: monospace; line-height: 1.6; font-weight: bold; font-size: 16px;">
        <p>&#9989 [VSPPM] Server is running.</p>
        <p><strong>Server Time (Nigerian):</strong> ${serverTime}</p>
        <p><strong>Daily Schedule for OG-Scrap:</strong></p>
        <ul>
          <li>3:00 AM - Scrape sft</li>
          <li>10:00 AM - Scrape Jobs-Ac</li>
        </ul>
        <p>CXHOW..</strong></p>
      </div>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

async function runWithLock(fn, label) {
  if (isJobRunning) {
      console.log(`⚠️ Skipping ${label} — another job is still running.`);
      return;
  }
  isJobRunning = true;
  try {
      await fn();
  } finally {
      isJobRunning = false;
  }
};

// --- Cron Jobs Setup (time in gmt+1 -lagos/nigeria time) ---
//run only two scrappers per day; the next day no scrap
//monday run get_jobs_ac_data by 1am and academy by 11am
//tuesday no scrap
//wednesday run sa_base_scraper by 1am, base_scraper by 9am and scrap_predoc by 10pm
//thursday no scrap
//friday run get_jobs_ac_data by 1am and academy by 11am
//saturday run sa_base_scraper by 1am, base_scraper by 9am and scrap_predoc by 10pm
//sunday no scrap
async function setupCronJobs() {
  // 1:00 AM - First scrap of the day
    cron.schedule('0 14 * * *', async () => {
    console.log('🌅 1:00 AM - Scholarship-aid scrapper running..');
    await runWithLock(sa_base_scraper, 'sa_base_scraper');  if (isJobRunning===false) process.exit(0);
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  cron.schedule('0 3 * * *', async () => {
    console.log('🌅 3:00 AM - Sft scrapper running..');
    await runWithLock(base_scraper, 'base_scraper'); if (isJobRunning===false) process.exit(0);
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  //// 10:00 AM - Second scrap of the day
  cron.schedule('0 10 * * *', async () => {
    console.log('🌅 10:00 AM - Jobs-ac scrapper running..');
    await runWithLock(get_jobs_ac_data, 'get_jobs_ac_data'); if (isJobRunning===false) process.exit(0);
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  cron.schedule('0 14 * * *', async () => {
    console.log('🌅 2:00 PM - academy scraper running..');
    await runWithLock(academy, 'academy'); if (isJobRunning===false) process.exit(0);
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  cron.schedule('0 22 * * *', async () => {
    console.log('🌅 10:00 PM - predoc scrapper running..');
    await runWithLock(scrap_predoc, 'scrap_predoc');  if (isJobRunning===false) process.exit(0); //scrap_predoc, 'scrap_predoc'
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });



  console.log('📅 Daily Schedule:');
  console.log('   - 3:00 AM: First scrap');
  console.log('   - 10:00 AM: Second scrap');
  console.log('   - 2:00 PM: Third scrap');
  console.log('   - 6:00 PM: Fourth scrap');
}

// --- Server Startup and Graceful Shutdown ---
async function startServer() {
  try {
    const PORT = process.env.PORT || 5100;
    server.listen(PORT, async () => {
      console.log(`🟢 Server is live on port ${PORT}`);
      console.log(`⏰ Current Nigerian time: ${formatNigerianTime()}`);
      await setupCronJobs();
    });

    // Handle shutdown signals gracefully
    const shutdown = async () => {
      console.log("🔄 Shutting down server...");

      // Stop accepting new connections
      server.close(async (err) => {
        if (err) {
          console.error("❌ Error closing HTTP server:", err);
        } else {
          console.log("✅ HTTP server closed.");
        }

        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.log("⚠️ Forcing shutdown...");
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT', shutdown);  // For local Ctrl+C
    process.on('SIGTERM', shutdown); // For hosting platform stop commands
    process.on('SIGQUIT', shutdown); // For additional graceful shutdown

  } catch (error) {
    console.error("❌ Failed to start the server:", error);
    process.exit(1);
  }
}

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

startServer();
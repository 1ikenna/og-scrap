const cron = require("node-cron");

const {scrap_predoc} = require("./scrapers/predoc/predoc-main.js")
const {get_jobs_ac_data} = require("./scrapers/jobs-ac/jobs-ac-main.js")
const { getNigerianTime, formatNigerianTime } = require("./utils/dateHelpers.js");
const http = require("http");
// --- Core Application Logic ---


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
          <li>3:00 AM - Scrape predoc scholarships</li>
          <li>10:00 AM - Scrape Jobs-Ac PHD scholarships</li>
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

// --- Cron Jobs Setup ---
async function setupCronJobs() {
  // 4:00 AM - First scrap of the day
  cron.schedule('0 4 * * *', async () => {
    console.log('🌅 3:00 AM - Scraping new jobs - predoc..');
    await scrap_predoc(); process.exit(1);
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  //// 10:00 AM - Second scrap of the day
  cron.schedule('0 10 * * *', async () => {
    console.log('🌅 10:00 AM - Scraping new jobs - jbs-ac..');
    await get_jobs_ac_data(); process.exit(1);
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  console.log('📅 Daily Schedule:');
  console.log('   - 4:00 AM: First scrap');
  console.log('   - 10:00 AM: Second scrap');

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
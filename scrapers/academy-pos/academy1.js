

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');
const { storePosts, initializeDatabase,
  closeDatabase } = require('./academy-db.js');

function isValidDeadline(dateString) {
  // If date is unspecified, assume it's valid
  if (!dateString || dateString === 'Unspecified') return true;

  // Extract ISO date (YYYY-MM-DD) from deadline string
  const isoPattern = /^\d{4}-\d{2}-\d{2}/;
  if (!isoPattern.test(dateString)) return true; // Keep if not ISO format

  // No need to split - dateString is already just "YYYY-MM-DD"
  const date = new Date(dateString);

  // Check if date is valid
  if (isNaN(date.getTime())) return true;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Return true if date is in the future or today, false if in the past
  return date >= today;
};

// Reusable filter function
function filterExpiredDeadlines(jobArray) {
  return jobArray.filter(job => {
    const isValid = isValidDeadline(job.application_deadline);

    if (!isValid) {
      console.log(`⏭️ SKIPPING: Deadline "${job.application_deadline}" is expired - ${job.post_title}`);
    }

    return isValid;
  });
};

function cleanJobData(jobArray) {
  return jobArray.map(job => {
    // Helper function to clean text
    const cleanText = (text) => {
      if (!text || text === 'Unspecified') return text;

      return text
        .replace(/\s*\n\s*/g, ' ')  // Replace newlines with spaces
        .replace(/,\s*,/g, ',')      // Remove empty commas (,,)
        .replace(/\s+/g, ' ')        // Collapse multiple spaces to single space
        .replace(/,\s+(and\s+\d+\s+more)/i, ', $1')  // Clean up "and X more"
        .replace(/\s*,\s*/g, ', ')   // Standardize comma spacing
        .replace(/,\s*,/g, ',')      // Remove any remaining empty commas
        .replace(/,\s+(?![^,]*and\s+\d+\s+more)/g, ', ') // Normalize comma spacing
        .trim();                      // Trim leading/trailing whitespace
    };

    // Clean deadline: remove duplicate date entries and extra whitespace
    const cleanDeadline = (deadline) => {
      if (!deadline || deadline === 'Unspecified') return deadline;

      // Get unique lines, filter out empty ones, take first valid date
      const lines = deadline.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.length > 0);

      // Remove duplicates while preserving order
      const uniqueLines = [];
      for (const line of lines) {
        if (!uniqueLines.includes(line)) {
          uniqueLines.push(line);
        }
      }

      return uniqueLines[0].split(" ")[0] || deadline; // Return first unique date
    };

    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline)
    };
  });
};

async function extractPostDetails (postLink, page) {
  //extraction of post details in second page from the post primary link scrapped from first page
  try {
    console.log(`post link: ${postLink}`);
    await page.goto(`${postLink}`, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("#jobDetails", {
      visible: true,
      timeout: 0,
    });

    let post_title = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    });


    let post_Inst = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    });

    let field = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    });

    //post_Inst = trimInst(post_Inst);

    let app_link = await page.evaluate(() => {
      const element = document.querySelector('#gtm-job-ad-apply-now-bottom-section'); //if link == apply; app_Link = Post_Link
      return element ? element.href : null;
    });

    let post_deadline = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    }); //deadline format: 2026-06-14 || Unspecified


    let data = {
      post_title: post_title.trim(),
      institution: post_Inst.trim(),
      field: field.trim(),
      application_link: app_link,
      application_deadline: post_deadline.trim(),     //rolling posts deleted at the end of the scrap year (db code using the extracted year to delete post from db)
      postLink: `${postLink}`,
      insertionDate: formatDateForDB()
    };

    return data;
  } catch (error) {
    console.error(error.message)
  }

};


async function scrapeAllPages (startUrl, maxPages = 16) {


    let browser;
    browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--single-process',
    ],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });


  let page;

  try {

    page = await browser.newPage();
    // remove timeout limit
    page.setDefaultNavigationTimeout(0);

    // Block images, stylesheets, and fonts to save memory and bandwidth
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let userAgent = new UserAgent({ deviceCategory: "mobile" }); //desktop
    let randomAgent = userAgent.toString();
    await page.setUserAgent(randomAgent);

    let currentUrl = startUrl;  let nextPageLink; let stockLink = "https://academicpositions.com/jobs/position/phd?page=";
    let pageNum = 1;

    while (pageNum <= maxPages) {

      console.log(`\n📄 Scraping page ${pageNum}: `); //${currentUrl}

      // Navigate to the current page
      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
      });


      await page.waitForSelector("h2", {
        visible: true,
        timeout: 0,
      });


      let links = await page.evaluate(() => {
        let jobListingElements = document.querySelectorAll(".list-group-item.text-reset.text-decoration-none > a");
        let extractedLinks = [];

        jobListingElements.forEach((link) => {
          if (link.href) {
            extractedLinks.push(link.href);
          }
        });

        return extractedLinks;
      });

      //links = links.slice(0, 10);
      let postsDetailsArr = [];


      for (let i = 0; i < links.length; i++) {
        console.log(`\n📌 Processing post ${i + 1}/${links.length}`);
        try {
          const result = await extractPostDetails(links[i], page);
          if (result) {
            postsDetailsArr.push(result);
            console.log(`✅ Post ${i + 1} added successfully`);
          } else {
            console.log(`⏭️ Post ${i + 1} skipped (deadline expired)`);
          }
        } catch (err) {
          console.error(`❌ Failed to extract post ${i + 1}:`, err.message);
        }

        // Wait between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      };

      console.log(`\n🎉 Extraction complete!`);
      console.log(`Total posts collected: ${postsDetailsArr.length}`);
      postsDetailsArr = cleanJobData(postsDetailsArr);
      //check for stale dates here using filter
      postsDetailsArr = filterExpiredDeadlines(postsDetailsArr); //filter out "Unspecified deadline"
      postsDetailsArr = postsDetailsArr.filter(p=>{
        if(p.application_deadline != "Unspecified") {
          return p
        }
      });

      console.log(`✅ Total valid posts after filtering: ${postsDetailsArr.length}`);
      //console.log(postsDetailsArr); //send batch to DB here;
      let result = await storePosts(postsDetailsArr);
      if (result && result.success && result.inserted) {console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result)} else {console.log('No new documents available to insert at this time..', result)};
      /*console.log("proceeding to find next page link..")
      let dt =  await page.goto(currentUrl, {
      waitUntil: "domcontentloaded",
    });*/

    //console.log(dt)
    //https://academicpositions.com/jobs/position/phd?page=3

      if (pageNum < maxPages) {
        pageNum++;
        nextPageLink = stockLink + `${pageNum}`;
        console.log(`🔗 Next page link found:\n `, nextPageLink); //${nextPageLink}
        currentUrl = nextPageLink;


        // Add delay between page requests
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`📌 No more pages or reached max pages (${maxPages})`);
        break;
      }


     };




    await page.close();
    await browser.close();
    return;


  } catch (error) {
    console.error(error);
  }
};


async function academy () {

  try {

    await initializeDatabase();

    const baseUrl = "https://academicpositions.com/jobs/position/phd?page=";

    await scrapeAllPages(baseUrl, 16);

    await closeDatabase();
    console.log('returning to outer cron scope?...')
    return;


  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}


//console.profile();
academy();
//module.exports = {scrapJobs}

//limit pg - 10
const fs = require('fs');
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');
const { storePosts, checkPostsCount, initializeDatabase, closeDatabase } = require('./sa-db.js');

async function sa_base_scraper() {
  try {
    await initializeDatabase();
    const baseUrl = "https://scholarshipsandaid.org/category/scholarships/";
    await sa_scrap(baseUrl, 5);
    await closeDatabase();
  } catch (error) {
    console.error(error.message);
  }
}

async function sa_scrap(startUrl, maxPages = 5) {
  let browser;

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--single-process'
    ],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };

  if (process.env.NODE_ENV === 'development') {
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];

    const chromePath = possiblePaths.find(p => fs.existsSync(p));

    if (!chromePath) {
      throw new Error('Could not find local Chrome. Check your installation path.');
    }

    launchOptions.executablePath = chromePath;
    console.log('Using Chrome at:', chromePath);
  }

  browser = await puppeteer.launch(launchOptions);

  let page;

  try {
    page = await browser.newPage();
    // Use a reasonable timeout instead of 0 to avoid infinite hanging on Render free tier
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

    let userAgent = new UserAgent({ deviceCategory: "mobile" });
    let randomAgent = userAgent.toString();

    let currentUrl = startUrl;
    let nextPageLink;
    let stockLink = "https://scholarshipsandaid.org/category/scholarships/page/";
    let pageNum = 1;
    let ttLinks = [];

    while (pageNum <= maxPages) {
      console.log(`\n📄 Scraping page ${pageNum}: `);
      await page.setUserAgent(randomAgent);
      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForSelector(".read-title", {
        visible: true,
        timeout: 0,
      });

      let links = await page.evaluate(() => {
        let jobListingElements = document.querySelectorAll(".read-title > h3 > a");
        let extractedLinks = [];

        jobListingElements.forEach((link) => {
          if (link.href) {
            extractedLinks.push(link.href);
          }
        });

        return extractedLinks;
      });

      if (links.length > 0) {
        console.log(`found ${links.length} links..`);
      }

      console.log(`proceeding to extract links...`);

      // PASS THE BROWSER OBJECT HERE INSTEAD OF THE SHARED PAGE OBJ
      let extracted_data = await extractLinkDetails(links, browser);
      console.log(`extracted ${extracted_data.length} docs from page ${pageNum}`);

      if (typeof extracted_data == "object") {
        ttLinks.push(...extracted_data);
      }

      if (pageNum < maxPages) {
        pageNum++;
        nextPageLink = stockLink + `${pageNum}`;
        console.log(`🔗 Next page link found:\n `, nextPageLink);
        currentUrl = nextPageLink;

        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`📌 No more pages or reached max pages (${maxPages})`);
        console.log(`total docs extracted: ${ttLinks.length}`);

        await checkPostsCount();
        let result = await storePosts(ttLinks);
        if (result && result.success && result.inserted) {
          console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result);
          process.exit(0);
        } else {
          console.log('No new documents available to insert at this time..', result);
          process.exit(0);
        }
        break;
      }
    }

    await page.close();
    await browser.close();
    console.log('returning to outer cron scope?...');
    return;

  } catch (error) {
    console.error(error.message);
    if (browser) await browser.close();
    return;
  }
}

async function extractLinkDetails(links, browser) {
  let extracted_posts = [];

  for (let i = 0; i < links.length; i++) {
    let detailPage;
    try {
      // Create a dedicated page for this specific iteration to protect lifecycle scopes
      detailPage = await browser.newPage();
      //detailPage.setDefaultNavigationTimeout(30000);

      // Intercept assets on the child page as well to preserve Render's RAM limits
      await detailPage.setRequestInterception(true);
      detailPage.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      console.log(`[${i + 1}/${links.length}] Extracting details from link: ${links[i]}`);
      await detailPage.goto(`${links[i]}`, {
        waitUntil: "domcontentloaded",
      });

      await detailPage.waitForSelector(".entry-title", {
        visible: true,
        timeout: 0,
      });

      let post_title = await detailPage.evaluate(() => {
        const element = document.querySelector('.entry-title');
        return element ? element.textContent : null;
      });

      let pel = await detailPage.evaluate(() => {
        let pElement = Array.from(document.querySelectorAll("p")).map(el => el.textContent);
        pElement = pElement.filter(el => {
          if (el.includes("Application Deadline")) {
            return el;
          }
        });
        return pElement.toString();
      });

      pel = pel.length > 0 ? pel : null;

      let deadline;
      if (pel !== null) {
        if (pel.includes(":")) {
          deadline = pel.split(":")[1].trim().split(".")[0].trim();
        } else {
          console.log("Malformed date string missing semi-colon separator.");
          continue;
        }
      } else {
        console.log("no date data available..");
        continue;
      }

      let article_link = await detailPage.evaluate(() => {
        const element = document.querySelector('.wp-block-heading > a');
        return element ? element.href : null;
      });

      if (article_link == null || post_title == null) {
        continue;
      }

      let checkDateValidity = isFutureDate(deadline);

      if (!checkDateValidity) {
        console.log('expired deadline: ', deadline);
        continue;
      }

      let post_block = {
        posttitle: post_title,
        deadline: deadline,
        postlink: article_link,
        origin: links[i],
        insertionDate: formatDateForDB()
      };

      extracted_posts.push(post_block);

    } catch (error) {
      console.error(`Error processing link ${links[i]}:`, error.message);
      return;
    }
  }
  return extracted_posts;
}

function isFutureDate(dateString) {
  // Pattern 1: Month Day, Year (e.g., September 1, 2026 or September 1st, 2026)
  const patternMDY = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})$/i;

  // Pattern 2: Day Month, Year (e.g., 1 September, 2026 or 1st September, 2026)
  const patternDMY = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),\s+(\d{4})$/i;

  let match = dateString.match(patternMDY);
  let monthName, day, year;

  if (match) {
    monthName = match[1];
    day = parseInt(match[2], 10);
    year = parseInt(match[3], 10);
  } else {
    match = dateString.match(patternDMY);
    if (match) {
      day = parseInt(match[1], 10);
      monthName = match[2];
      year = parseInt(match[3], 10);
    } else {
      console.log("invalid date format: ", dateString);
      return false;
    }
  }

  monthName = monthName.charAt(0).toUpperCase() + monthName.slice(1).toLowerCase();

  const months = {
    'January': 0, 'February': 1, 'March': 2, 'April': 3,
    'May': 4, 'June': 5, 'July': 6, 'August': 7,
    'September': 8, 'October': 9, 'November': 10, 'December': 11
  };

  const month = months[monthName];

  if (month === undefined) {
    console.log("Unknown month name: ", monthName);
    return false;
  }

  const inputDate = new Date(year, month, day);

  if (inputDate.getFullYear() !== year ||
      inputDate.getMonth() !== month ||
      inputDate.getDate() !== day) {
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return inputDate > today;
}

//sa_base_scraper();
module.exports = { sa_base_scraper };
//limit pg - 10
const fs = require('fs');
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');
const { storePosts, checkPostsCount, initializeDatabase,
  closeDatabase } = require('./sft-db.js');


async function base_scraper () {
  try {
    await initializeDatabase();
    const baseUrl = "https://scholarshipsfuture.com/";
    await sft_scrap(baseUrl, 1);
    await closeDatabase();
  } catch (error) {
    console.error(error.message)
  }
};


async function sft_scrap (startUrl, maxPages = 1) {


  let browser;

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--disable-gpu', '--disable-web-security', '--disable-features=VizDisplayCompositor', '--single-process'],
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

    let currentUrl = startUrl;  let nextPageLink; let stockLink = "https://scholarshipsfuture.com/page/";
    let pageNum = 1; let ttLinks = [];

    while (pageNum <= maxPages) {

      console.log(`\n📄 Scraping page ${pageNum}: `);
      await page.setUserAgent(randomAgent);
      await page.goto(currentUrl, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForSelector(".elementor-widget-container", {
        visible: true,
        timeout: 0,
      });


      let links = await page.evaluate(() => {
        let jobListingElements = document.querySelectorAll(".elementor-post__thumbnail__link");
        let extractedLinks = [];

        jobListingElements.forEach((link) => {
          if (link.href) {
            extractedLinks.push(link.href);
          }
        });

        return extractedLinks;
      });

      //links = links.slice(0, 10); //limit to first 10 links for testing

     //extract text body here
     //see if the iterations can be all run in parallel to save time? - but will that crash the memory? can db accept paralallel writes?
      if (links.length > 0) {
          console.log(`found ${links.length} links..`)
      };

      console.log(`proceeding to extract links...`);


      //links = links.slice(3);
      let extracted_data = await extractLinkDetails(links, page);
      console.log(`extracted ${extracted_data.length} docs from page ${pageNum}`);
      if (typeof extracted_data == "object")
      ttLinks.push(...extracted_data);

      if (pageNum < maxPages) {
        pageNum++;
        nextPageLink = stockLink + `${pageNum}`;
        console.log(`🔗 Next page link found:\n `, nextPageLink); //${nextPageLink}
        currentUrl = nextPageLink;

        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`📌 No more pages or reached max pages (${maxPages})`);
        console.log(`total docs extracted: ${ttLinks.length}\nadding to db..`);
        await checkPostsCount();
        let result = await storePosts(ttLinks);
        if (result && result.success && result.inserted) {console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result)} else {console.log('No new documents available to insert at this time..', result)};
        break;
      }

    };



    await page.close();
    await browser.close();
    console.log('returning to outer cron scope?...')
    return;


  } catch (error) {
    console.error(error);
  }
};


async function extractLinkDetails(links, page) {
  let extracted_posts = [];

  for (let i = 0; i<links.length; i++) {
    try {
      //console.log(`extracting details from link: ${links[i]}`);
      await page.goto(`${links[i]}`, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForSelector(".entry-title", {
        visible: true,
        timeout: 0,
      });

      let post_title = await page.evaluate(() => {
        const element = document.querySelector('.entry-title');
        return element ? element.textContent : null;
      });

      let post_details = await page.evaluate(() => {
          const element = document.querySelector('.wp-block-list');
          return element ? element.textContent : null;
        });

        let article_link = await page.evaluate(() => {
          const element = document.querySelector('.has-vivid-red-color > a');
          return element ? element.href : null;
        });

      if(article_link == null) {
        continue;
      }

      post_details = post_details.split("\n").filter(a=>a.length>1); //post_details[post_details.length] = article_link;
      post_details = post_details.filter(b=> {

        if(post_details.indexOf(b)==0) {
          return b
        }

        if (b.includes(":") && b.split(":")[1].length > 0) {
          return b
        }
      })

      //if it does not have text after :, remove, remove elements that don't contain : and .
      if(/deadline/gi.test(post_details)!=true) {
        //console.log("post does not have a deadline property\nmoving to next post..")
        continue;
      };

      let checkDateValidity = extractFutureDateFromArray(post_details)

      if(!checkDateValidity.datevalid) {
        //console.log('date not valid', post_details)
        continue;
      };

      post_details = post_details.filter(c=>{
        const isDeadline = c.toLowerCase().includes("deadline") ||
        c.toLowerCase().includes("application deadline");
          return !isDeadline;
      })


      post_details = post_details.slice(1);

        let post_block = {
          posttitle : post_title,
          postdetails : post_details.join("\n"),
          deadline: checkDateValidity.dateformat,
          postlink : article_link,
          origin: links[i],
          insertionDate: formatDateForDB()
        }

      extracted_posts.push(post_block)

    } catch (error) {
        console.error(error.message)
    }
  };
  return extracted_posts;
};


function extractFutureDateFromArray(arr) {
  // Combine array into a single string
  const text = arr.join(' ');

  // Updated regex to handle ordinal indicators (st, nd, rd, th) and time information
  // Pattern 1: "DD Month" or "DDth Month" (e.g., "1 August", "21st May")
  // Pattern 2: "DD Month YYYY" or "DDth Month YYYY" (e.g., "6 July 2026", "21st May 2026")
  // Pattern 3: "Month DD" or "Month DDth" (e.g., "August 19", "May 21st")
  // Pattern 4: "Month DD, YYYY" or "Month DDth, YYYY" (e.g., "September 10, 2026")

  const datePattern = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;

  let firstMatch = null;
  let earliestIndex = Infinity;

  // Find the first occurring date in the text
  let match;
  while ((match = datePattern.exec(text)) !== null) {
    if (match.index < earliestIndex) {
      earliestIndex = match.index;
      firstMatch = match;
    }
  }

  if (!firstMatch) {
    return { datevalid: false, dateformat: null };
  }

  // Parse the matched date and format the output
  let parsedDate = null;
  let formattedDate = null;
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                     'july', 'august', 'september', 'october', 'november', 'december'];

  // Case 1: "DD Month" or "DD Month YYYY" (with optional ordinal indicators)
  if (firstMatch[1] && firstMatch[2]) {
    const day = parseInt(firstMatch[1]);
    const month = monthNames.indexOf(firstMatch[2].toLowerCase());
    const originalMonth = firstMatch[2];
    const year = firstMatch[3] ? parseInt(firstMatch[3]) : null;

    if (year) {
      // "DD Month YYYY" - complete
      parsedDate = new Date(year, month, day);
      formattedDate = `${day} ${originalMonth} ${year}`;
    } else {
      // "DD Month" - complete with appropriate year
      const currentYear = new Date().getFullYear();
      parsedDate = new Date(currentYear, month, day);

      let targetYear = currentYear;
      if (parsedDate < new Date()) {
        targetYear = currentYear + 1;
        parsedDate = new Date(targetYear, month, day);
      }
      formattedDate = `${day} ${originalMonth} ${targetYear}`;
    }
  }
  // Case 2: "Month DD" or "Month DD YYYY" (with optional ordinal indicators)
  else if (firstMatch[4] && firstMatch[5]) {
    const month = monthNames.indexOf(firstMatch[4].toLowerCase());
    const day = parseInt(firstMatch[5]);
    const originalMonth = firstMatch[4];
    const year = firstMatch[6] ? parseInt(firstMatch[6]) : null;

    if (year) {
      // "Month DD, YYYY" - complete
      parsedDate = new Date(year, month, day);
      formattedDate = `${originalMonth} ${day}, ${year}`;
    } else {
      // "Month DD" - complete with appropriate year
      const currentYear = new Date().getFullYear();
      parsedDate = new Date(currentYear, month, day);

      let targetYear = currentYear;
      if (parsedDate < new Date()) {
        targetYear = currentYear + 1;
        parsedDate = new Date(targetYear, month, day);
      }
      formattedDate = `${originalMonth} ${day} ${targetYear}`;
    }
  }

  // Check if the date is valid
  if (!parsedDate || isNaN(parsedDate.getTime())) {
    return { datevalid: false, dateformat: null };
  }

  // Check if the date is in the future
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const futureDate = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate());

  const isFuture = futureDate > today;

  return {
    datevalid: isFuture,
    dateformat: formattedDate
  };
};



//console.profile();
//base_scraper();
module.exports = {base_scraper}

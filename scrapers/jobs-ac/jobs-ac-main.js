
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');
const { storePosts, initializeDatabase,
  closeDatabase } = require('./jobs-ac-db.js');

{/**UTILITIES START */}
function trimInst(text) {
  if (!text) return '';

  // Remove whitespace, newlines, and extra spaces
  let cleaned = text
    .replace(/[\n\r\t]+/g, ' ')  // Replace newlines/tabs with space
    .replace(/\s+/g, ' ')         // Collapse multiple spaces
    .replace(/^\s+|\s+$/g, '')    // Trim start and end
    .replace(/\s*-\s*/g, ' - ')   // Clean up hyphens with spaces
    .replace(/\s+/g, ' ')         // Final space cleanup
    .trim();

  return cleaned;
};

function cleanPhdTitle(text) {
  const phdPatternsToRemove = [
    "Phd Studentship:",
    "PhD Studentship -",
    ", PhD \\(Funded\\)",     // Escape parentheses and match comma
    "PhD \\(Funded\\)",        // Also match without comma
    ", PhD \\(Funded\\)$",     // Match at end of string
    "\\s*,\\s*PhD \\(Funded\\)", // Match with flexible whitespace
    //"PhD Studentship in", match if it starts the line eg. PhD Studentship in Bioinformatics and Cardiovascular Biology - Exploring the Application of Geocomputational Methods to High Resolution Spatial Transcriptomics Data from the Human Heart
    "Fully Funded",
    "PhD in"
  ];

  let cleanedText = text;
  for (const pattern of phdPatternsToRemove) {
    cleanedText = cleanedText.replace(new RegExp(pattern, 'gi'), '');
  }
  return cleanedText.trim();
};

function getValidDeadline(deadlineString) {
  if (!deadlineString || deadlineString.trim() === '') {
    return null;
  }

  let cleaned = deadlineString.trim();
  cleaned = cleaned.replace(/(\d+)(?:st|nd|rd|th)/gi, '$1');

  let parsedDate = new Date(cleaned);

  if (isNaN(parsedDate.getTime())) {
    // Try UK format: DD Month YYYY
    const months = {
      'january': 0, 'jan': 0, 'february': 1, 'feb': 1, 'march': 2, 'mar': 2,
      'april': 3, 'apr': 3, 'may': 4, 'june': 5, 'jun': 5, 'july': 6, 'jul': 6,
      'august': 7, 'aug': 7, 'september': 8, 'sep': 8, 'sept': 8, 'october': 9,
      'oct': 9, 'november': 10, 'nov': 10, 'december': 11, 'dec': 11
    };

    const dateMatch = cleaned.match(/(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/i);
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const monthName = dateMatch[2].toLowerCase();
      const year = parseInt(dateMatch[3], 10);
      const month = months[monthName];

      if (month !== undefined && day >= 1 && day <= 31) {
        parsedDate = new Date(year, month, day);
      }
    }
  }

  if (isNaN(parsedDate.getTime())) {
    return null;
  }

  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  return parsedDate >= currentDate ? parsedDate : null;
};

async function extractPostDetails (postLink, page) {
  //extraction of post details in second page from the post primary link scrapped from first page
  console.log(`post link: ${postLink}`);
  await page.goto(`${postLink}`, {
    waitUntil: "domcontentloaded",
  });

  await page.waitForSelector(".j-advert__title", {
    visible: true,
    timeout: 0,
  });

  let post_title = await page.evaluate(() => {
    const element = document.querySelector('.j-advert__title');
    return element ? element.textContent : null;
  });

  post_title = cleanPhdTitle(post_title);

  //check if post_title contains this string, "Phd Studentship:", replace with empty string and trim
  let post_position = await page.evaluate(() => {
    const element = document.querySelector('#qualification');
    return element ? element.textContent : null;
  });


  let post_Inst = await page.evaluate(() => {
    const element = document.querySelector('.j-advert__employer');
    return element ? element.textContent : null;
  });

  post_Inst = trimInst(post_Inst);

  let app_link = await page.evaluate(() => {
    const element = document.querySelector('.row-7 > a');
    return element ? element.href : null;
  });

  let post_deadline = await page.evaluate(() => {
    const element = document.querySelector('body > div.grid.grid__2-col.grid__2-col--left.grid__2-col--large-right.ie11-min-width > div.sub-grid.column-1.edge-span-2-mobile > div.j-advert-details__container.row-5 > div > div.j-advert-details__second-col > table > tbody > tr:nth-child(2) > td');
    return element ? element.textContent : null;
  });

  const validDeadline = getValidDeadline(post_deadline);

  if (!validDeadline) {
    console.log(`⏭️ SKIPPING: Deadline "${post_deadline}" is expired or invalid - ${post_title}`);
    return null; // Skip this post
  }

  let data = {
    position: post_position,
    post_title: post_title,
    institution: post_Inst,
    application_link: app_link,
    application_deadline: post_deadline,     //rolling posts deleted at the end of the scrap year (db code using the extracted year to delete post from db)
    postLink: `${postLink}`,
    insertionDate: formatDateForDB()
  };

  return data;

};


async function scrapeAllPages(startUrl, maxPages = 8) {

try {

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
  //let allLinks = [];
  let currentUrl = startUrl;
  let pageNum = 1;

  while (pageNum <= maxPages) {
    console.log(`\n📄 Scraping page ${pageNum}: `); //${currentUrl}

    // Navigate to the current page
    await page.goto(currentUrl, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("#job-listings", {
      visible: true,
      timeout: 0,
    });

    // Extract links from current page
    let links = await page.evaluate(() => {
      let jobListingElements = document.querySelectorAll(".j-search-result__text>a");
      let extractedLinks = [];

      jobListingElements.forEach((link) => {
        if (link.href) {
          extractedLinks.push(link.href);
        }
      });

      return extractedLinks;
    });

    //batch store here

    console.log(`✅ Found ${links.length} links on page ${pageNum}`);
    console.log(`proceeding to process ${links.length} links..`); //links = links.splice(0, 3);
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
    }


    console.log(`\n🎉 Extraction complete!`);
    console.log(`Total posts collected: ${postsDetailsArr.length}`);

    //console.log(postsDetailsArr)
    //console.log(`Posts with future deadlines: ${postsDetailsArr.length}`);

    let result = await storePosts(postsDetailsArr);
    if (result && result.success && result.inserted) {console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result)} else {console.log('No new documents available to insert at this time..', result)};


    //allLinks.push(...links);

    // Try to find the next page link
    console.log("proceeding to find next page link..")
      let dt =  await page.goto(currentUrl, {
      waitUntil: "domcontentloaded",
    });

    //console.log(dt)
    //console.log(`page: `, page)
    const nextPageLink = await page.evaluate(() => {
      const nextButton = document.querySelector("#results > div.j-search-content__pagination.j-search-content__pagination--center.j-search-content__results-footer > div > span > a");
      if (nextButton && nextButton.href) {
        return nextButton.href;
      }
      return null;
    });

    //console.log(nextPageLink)

    if (nextPageLink && pageNum < maxPages) {
      console.log(`🔗 Next page link found: `); //${nextPageLink}
      currentUrl = nextPageLink;
      pageNum++;

      // Add delay between page requests
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      console.log(`📌 No more pages or reached max pages (${maxPages})`);
      break;
    }
  }

  console.log(`\n📊 completed scrap and post events..`);
  await page.close();
  await browser.close();
} catch (error) {
  console.error(error)
}


}

{/**UTILITIES eND */}

async function get_jobs_ac_data () {



  try {

   await initializeDatabase();

    const baseUrl = "https://www.jobs.ac.uk/search/?academicDisciplineFacet[0]=psychology&academicDisciplineFacet[1]=physical-and-environmental-sciences&subDisciplineFacet[0]=geography&academicDisciplineFacet[2]=mathematics-and-statistics&subDisciplineFacet[1]=mathematics&subDisciplineFacet[2]=statistics&academicDisciplineFacet[3]=computer-sciences&subDisciplineFacet[3]=computer-science&subDisciplineFacet[4]=information-systems&subDisciplineFacet[5]=artificial-intelligence&subDisciplineFacet[6]=cyber-security&academicDisciplineFacet[4]=engineering-and-technology&subDisciplineFacet[7]=other-engineering&academicDisciplineFacet[5]=architecture-building-and-planning&subDisciplineFacet[8]=urban-and-rural-planning&academicDisciplineFacet[6]=economics&academicDisciplineFacet[7]=social-sciences-and-social-care&subDisciplineFacet[9]=sociology&subDisciplineFacet[10]=social-policy&subDisciplineFacet[11]=human-and-social-geography&academicDisciplineFacet[8]=information-management-and-librarianship&subDisciplineFacet[12]=information-science&jobTypeFacet[0]=phds&expired-job-redirect=true";

    // Scrape all pages (max 8 pages as requested)
   await scrapeAllPages(baseUrl, 8);

    await closeDatabase();
    //await page.close();
    //await browser.close();
    console.log('returning to outer cron scope?...')
    return;


  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}


//get_jobs_ac_data();
module.exports = {get_jobs_ac_data}

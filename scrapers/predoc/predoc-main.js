const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');
const { storePosts, checkPostsCount, initializeDatabase,
    closeDatabase } = require('./predoc-db.js');

function parseDeadline(deadlineText) {
    const rollingKeywords = ['rolling', 'rolling basis', 'accepted on a rolling basis', 'considered on a rolling basis', 'first review'];
    if (rollingKeywords.some(keyword => deadlineText.toLowerCase().includes(keyword))) {
        return { isValid: true, date: null, displayText: 'Rolling' };
    }

    const patterns = [
        // 1. ADD THIS: Specific DD/MM/YYYY or D/M/YYYY (European/Global format)
        {
          regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
          parse: (m) => new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]))
        },
        // 2. Month Day, Year (e.g., April 1st, 2026)
        {
          regex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})/,
          parse: (m) => new Date(`${m[1]} ${m[2]}, ${m[3]}`)
        },
        // 3. MM/DD/YY (American short format) - keep this as a fallback
        {
          regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
          parse: (m) => {
            let year = 2000 + parseInt(m[3]);
            return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
          }
        }
    ];

    for (const pattern of patterns) {
        const match = deadlineText.match(pattern.regex);
        if (match) {
            try {
                const date = pattern.parse(match);
                if (!isNaN(date.getTime())) {
                    const now = new Date();
                    now.setHours(0, 0, 0, 0); // Reset time to compare only dates

                    // CRITICAL: Ensure the date is strictly today or in the future
                    if (date >= now) {
                        return {
                            isValid: true,
                            date,
                            displayText: date.toLocaleDateString('en-GB') // Standardize to DD/MM/YYYY for display
                        };
                    }
                }
            } catch (e) { continue; }
        }
    }
    return { isValid: false, date: null, displayText: null };
}

function filterFutureDeadlines(posts) {
    return posts.filter(post => {
        // Find the line containing the deadline keywords
        let deadlineIndex = post.textLines.findIndex(line =>
            line.toLowerCase().includes('deadline') || line.toLowerCase().includes('first review')
        );

        // If no deadline info is found, we assume it's rolling/permanent
        if (deadlineIndex === -1) return true;

        let deadlineValue = post.textLines[deadlineIndex];

        // Clean the label to get just the date string
        let deadlineText = deadlineValue
            .replace(/deadline:?\s*/i, '')
            .replace(/first review date:?\s*/i, '')
            .trim();

        const result = parseDeadline(deadlineText);

        if (result.isValid) {
            // Update the line in the original object with the cleaned date
            post.textLines[deadlineIndex] = `Deadline: ${result.displayText}`;
            return true; // Keep the post
        }

        return false; // Remove the post because the date is in the past
    });
}

async function scrap_predoc() {

    let browser = await puppeteer.launch({
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

    try {
        const page = await browser.newPage();
        let userAgent = new UserAgent({ deviceCategory: "mobile" });
        await page.setUserAgent(userAgent.toString());

        await page.goto("https://www.predoc.org/opportunities", { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".swiss-text", { timeout: 30000 });

        let textData = await page.evaluate(() => {
            const containers = document.querySelectorAll(".swiss-text");
            return Array.from(containers).map(container => {
                const link = container.querySelector("a")?.href || null;
                const rawText = container.textContent.trim();
                const textLines = rawText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                return { textLines, link };
            }).filter(item => item.textLines.length > 0);
        });

        // Clean and Reformat lines
        let cleanedData = textData.map(obj => {
            let lines = obj.textLines;
            // Extract the heading (usually the last line in the raw swiss-text block)
            let heading = lines[lines.length - 1];
            let details = lines.slice(0, lines.length - 1);

            let processedLines = [heading, ...details]
                .filter(st => !/NOTE:|INFO SESSION|Start Date:|Expected Start Date:/i.test(st));

            return {
                textLines: [...new Set(processedLines)],
                link: obj.link
            };
        });

        let filteredPosts = filterFutureDeadlines(cleanedData);
        //filteredPosts = filteredPosts.slice(0, 10);
        console.log('completed deadline filter...');
        console.log(`\n=== Original posts: ${cleanedData.length} ===`);
        console.log(`=== Valid future posts: ${filteredPosts.length} ===\n`);

        async function telegram () {

            let finalPosts = filteredPosts.map((post, index) => {
                //console.log(post)
                let post_copy = [...post.textLines]; let post_copy2 = [...post_copy];
                let postLink = post.link;
                let post_m = post.textLines;
                let deadline_index = post.textLines.findIndex(item => item.includes('Deadline'));

                // Guard clause: skip posts without deadline
                if (deadline_index === -1) {
                    console.log(`Skipping post without deadline: ${post_m[0] || 'Unknown title'}`);
                    return null; // Will be filtered out later
                }


                let post_deadline = post_copy[deadline_index].split(":")[1].trim();

                let post_heading = post_m[0];
                let visa_index = post_m.findIndex(item => item.includes('Visa:'));
                if (visa_index !== -1) {
                    post_m[visa_index] = 'Visa sponsorship available'
                };

                post_m = post_m.filter(item => !item.includes('Deadline'));
                post_m = post_m.map(x => '🔰 ' + x);
                post_m = [...post_m.slice(1, 2), ...post_m.slice(2)];

                post_m = post_m.map((post, index)=>{
                    if(index===0) {
                        return post.split("🔰 ")[1]
                    } else {
                        return post
                    }
                });

                //console.log(post_m)
                post_m = post_m.filter(post=>{
                    if(post.includes(":")) {
                        return post
                    }
                })

                post_m = post_m.filter((post, index)=>{
                    if(post.includes("Fields of Research:") || post.includes("Field(s) of Research:")) {
                        let split_field = post.split(":");
                        if(split_field[1].length>1 && /[a-zA-Z]/i.test(split_field) === true ) {
                            return post
                        }
                    } else {
                        return post
                    }
                })

               let post_b = post_m.map((post, index)=>{
                    if(index!==0) {
                        let split_txt = post.split(":");
                        //console.log(split_txt)
                        let j1 = `<b>${split_txt[0]}</b>`; let j2 = split_txt[1];
                        return j1 + ":"+ " "+j2;
                    } else {
                        return post
                    }
                })
                //console.log(post_m)

                post_b = `<b>${post_heading}</b>\n\n` + post_b.join('\n\n');

                //console.log(post_b)

                return {
                    post_title: post_heading,
                    body: post_b,
                    post_data_main: post_copy2,
                    app_link: postLink,
                    deadline: post_deadline,
                    insertionDate: formatDateForDB()
                };
            }).filter(post => post !== null); // Remove null entries


      /* finalPosts = finalPosts.filter((post, index)=>{
        if(post.body && post.body.includes("Fields of Research:") || post.body && post.body.includes("Field(s) of Research:")) {
            let p_body_arr = post.body.split("\n");
            let split_field = p_body_arr[fields_index]; split_field = split_field.split(":");
            if(split_field[1].length>1 && /[a-zA-Z]/i.test(split_field) === true ) {
                return post
            }

        }
      }) */

      return finalPosts
      //console.log(finalPosts); //add to db


      };

      let posts = await telegram(); //console.log(posts)

  try {
        await initializeDatabase();
        await checkPostsCount();
        let result = await storePosts(posts);
        if (result && result.success && result.inserted > 0) {console.log(`successfully stored ${result.inserted} posts ..\nDetails: `, result)} else {console.log(`No new documents available to insert at this time..`, result)};
        await closeDatabase();
      } catch (error) {
        await closeDatabase();
        console.error(error);
      }

    await page.close();
    await browser.close();
    console.log('returning to outer cron scope?...')
    return;

    } catch (error) {
        console.error("Scraping failed:", error); process.exit(1);
    }
}

//scrap_predoc();
module.exports = {scrap_predoc};
//Trying to avoid any npm installs or anything that takes extra time...
const   https = require('https'),
        zlib = require('zlib'),
        fs = require('fs'),
        env = process.env;

const MAX_RETRY_ATTEMPTS = 5;
const MAX_OLD_NUMBERS = 5;

function fail(message) {
    console.log(`::error::${message}`);
    process.exit(1);
}

function request(method, path, data, callback) {

    try {
        if (data) {
            data = JSON.stringify(data);
        }
        const options = {
            hostname: 'api.github.com',
            port: 443,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? data.length : 0,
                'Accept-Encoding' : 'gzip',
                'Authorization' : `token ${env.INPUT_TOKEN}`,
                'User-Agent' : 'GitHub Action - development'
            }
        }
        const req = https.request(options, res => {

            let chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                if (res.headers['content-encoding'] === 'gzip') {
                    zlib.gunzip(buffer, (err, decoded) => {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, res.statusCode, decoded && JSON.parse(decoded));
                        }
                    });
                } else {
                    callback(null, res.statusCode, buffer.length > 0 ? JSON.parse(buffer) : null);
                }
            });

            req.on('error', err => callback(err));
        });

        if (data) {
            req.write(data);
        }
        req.end();
    } catch(err) {
        callback(err);
    }
}

function getMaxBuildNumber(prefix, callback) {
    request('GET', `/repos/${env.GITHUB_REPOSITORY}/git/refs/tags/${prefix}build-number-`, null, (err, status, result) => {
        if (status === 404) {
            callback(null, 0, []);
            return;
        }
        if (err || status !== 200) {
            if (err) {
                callback(new Error(`Failed to get refs. Error: ${err}, status: ${status}`));
            } else {
                callback(new Error(`Getting build-number refs failed with http status ${status}, error: ${JSON.stringify(result)}`));
            }
            return;
        }
        const regex = new RegExp(`/${prefix}build-number-(\\d+)$`);
        const nrTags = result.filter(d => d.ref.match(regex));
        const nrs = nrTags.map(t => parseInt(t.ref.match(/-(\d+)$/)[1]));
        const currentMax = nrs.length > 0 ? Math.max(...nrs) : 0;
        callback(null, currentMax, nrTags);
    });
}

function retryDelay(attempt) {
    const stubMax = parseInt(env.STUB_RETRY_DELAY_MAX_MS, 10);
    const maxDelay = Number.isFinite(stubMax) ? stubMax : 500;
    if (maxDelay === 0) return 0;
    return Math.min(100 * attempt, maxDelay) + Math.floor(Math.random() * Math.min(100, maxDelay + 1));
}

function createRefWithRetry(prefix, number, nrTags, attempt, callback) {
    const newRefData = {
        ref: `refs/tags/${prefix}build-number-${number}`,
        sha: env.GITHUB_SHA
    };

    request('POST', `/repos/${env.GITHUB_REPOSITORY}/git/refs`, newRefData, (err, status, result) => {
        if (status === 201) {
            callback(null, number, nrTags);
            return;
        }

        if (status === 422 && attempt < MAX_RETRY_ATTEMPTS) {
            const delay = retryDelay(attempt);
            console.log(`Collision on ${prefix}build-number-${number} (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}), re-reading in ${delay}ms...`);
            setTimeout(() => {
                getMaxBuildNumber(prefix, (err2, newMax) => {
                    if (err2) { callback(err2); return; }
                    const next = newMax + 1;
                    console.log(`Re-read current max: ${newMax}. Retrying with build number ${next}...`);
                    createRefWithRetry(prefix, next, nrTags, attempt + 1, callback);
                });
            }, delay);
            return;
        }

        if (err) {
            callback(new Error(`Failed to create new build-number ref. Status: ${status}, Error: ${err}`));
        } else if (status === 422) {
            callback(new Error(`Failed to create new build-number ref after ${MAX_RETRY_ATTEMPTS} attempts (repeated 422 collisions). Status: 422, result: ${JSON.stringify(result)}`));
        } else {
            callback(new Error(`Failed to create new build-number ref. Status: ${status}, result: ${JSON.stringify(result)}`));
        }
    });
}

function main() {

    const path = 'BUILD_NUMBER/BUILD_NUMBER';
    const prefix = env.INPUT_PREFIX ? `${env.INPUT_PREFIX}-` : '';
    const deletePreviousTag = env.INPUT_DELETE_PREVIOUS_TAG !== 'false';

    //See if we've already generated the build number and are in later steps...
    if (fs.existsSync(path)) {
        let buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated in earlier jobs, using build number ${buildNumber}...`);
        //Setting the output and a environment variable to new build number...
        fs.writeFileSync(process.env.GITHUB_OUTPUT, `build_number=${buildNumber}`);
        fs.writeFileSync(process.env.GITHUB_ENV, `BUILD_NUMBER=${buildNumber}`);
        return;
    }

    //Some sanity checking:
    for (let varName of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
        if (!env[varName]) {
            fail(`ERROR: Environment variable ${varName} is not defined.`);
        }
    }

    getMaxBuildNumber(prefix, (err, currentMax, nrTags) => {
        if (err) {
            fail(err.message);
            return;
        }

        if (deletePreviousTag && nrTags.length > MAX_OLD_NUMBERS) {
            fail(`ERROR: Too many ${prefix}build-number- refs in repository, found ${nrTags.length}, expected only 1. Check your tags!`);
            return;
        }

        if (currentMax === 0) {
            console.log('No build-number ref available, starting at 1.');
        } else {
            console.log(`Last build nr was ${currentMax}.`);
            console.log(`Updating build counter to ${currentMax + 1}...`);
        }

        createRefWithRetry(prefix, currentMax + 1, nrTags, 1, (err, assignedNumber, finalNrTags) => {
            if (err) {
                fail(err.message);
                return;
            }

            console.log(`Successfully updated build number to ${assignedNumber}`);

            //Setting the output and a environment variable to new build number...
            fs.writeFileSync(process.env.GITHUB_OUTPUT, `build_number=${assignedNumber}`);
            fs.writeFileSync(process.env.GITHUB_ENV, `BUILD_NUMBER=${assignedNumber}`);

            //Save to file so it can be used for next jobs...
            fs.writeFileSync('BUILD_NUMBER', assignedNumber.toString());

            //Cleanup
            if (finalNrTags && deletePreviousTag) {
                console.log(`Deleting ${finalNrTags.length} older build counters...`);

                for (let nrTag of finalNrTags) {
                    request('DELETE', `/repos/${env.GITHUB_REPOSITORY}/git/${nrTag.ref}`, null, (err, status, result) => {
                        if (status !== 204 || err) {
                            console.warn(`Failed to delete ref ${nrTag.ref}, status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
                        } else {
                            console.log(`Deleted ${nrTag.ref}`);
                        }
                    });
                }
            } else if (finalNrTags && !deletePreviousTag) {
                console.log('Skipping deletion of previous build-number tags as requested.');
            }
        });
    });
}

main();

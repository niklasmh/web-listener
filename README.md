# Web listener

Using the GitHub Actions scheduler to listen for changes on the web. Can also be used locally.

**Why I made this:** Very often, I find myself in situations where I need to listen for changes on websites that do not have an inbuilt alert system.

## Initial setup

Set these env-vars (you can also use `.env.local`-file):

```bash
# Automatically open link in browser on notifications? Should be false on servers.
HEADLESS=<true|false>

# Should this run once in a while on a server? Then true. Or: Should this be ran as a continuos process (aka on your machine)? Then false.
FUNCTION=<true|false>

# Want to send Slack notifications? Find your Slack token.
SLACK_TOKEN=xoxb-xxxx-xxxx-xxxx
# To specify specific Slack users that should receive the notifications. We will reference to the <alias> later. If this is not done, the program will default to @channel.
USERS=<alias>:ID3289382983 # The ID can be found by clicking the vertical "..."-button on the Slack user profile then clicking the "Copy member ID".

# Link to list of listeners (gists are awesome for this).
LISTENERS_URL=https://gist.githubusercontent.com/niklasmh/xxxxxx/raw/xxxxxx/listeners.txt

# Getting useful output from the server.
DEBUG=<true|false>
```

## Creating a listener

See [`listener.example.md`](./listener.example.md) for inspiration.

### Local setup

- Create a file like [`listener.example.md`](./listener.example.md) in the root folder. Lets call it: `listener.some-product.md`
- Add `listener.some-product.md` to a file called: `listeners.txt` (see [`listeners.example.txt`](./listeners.example.txt))
- `npm start`

### GitHub Actions setup

- Add these environment variables as Action secrets: `LISTENERS_URL`, `SLACK_TOKEN`, `USERS`.
- `LISTENERS_URL` should point to a file on the internet that contains a list of URLs to the listeners. GitHub gists are perfect for this.
- Remember to allow GitHub Actions on the repository.

### File reference for web-listeners

````md
# Name of thing to listen to

```yaml
interval: 60 # in seconds
delay: 0 # in seconds
initialValue: { price: 0, location: "" } # Initial prevValue
compare: value.price !== prevValue.price # Some true/false expression
open: "https://website.com/product/locations/" + value.location # What to open in browser if locally. Can be a script using "value" as a variable.
notify: "Website had a change in price from $" + prevValue.price + " to $" + value.price # Message generated when sending Slack message.
user: niklasmh # List of Slack users (comma separated). If not specified, then @channel is used.
debug: true # See why things are triggered (value, prevValue etc.)
```

Fetch data, can be in form of `html`, `json` and `text`.

```fetch
html:https://website.com/product
```

Now `html` is set to a DOM object. Lets search through it and extract the value!

```javascript
const priceElement = html.querySelector("#price");
const price = priceElement.innerHTML.replace(/[^\d]/g, "");
return { price: parseInt(price) };
```

We now know the price. What if we want to know where to find it? (if that is the case)

```fetch
json:https://website.com/product/locations
```

Now the `json` variable is set to a parsed JSON object. Lets find the location:

```javascript
{ price: value.price, location: json.locations[0] }
```

Now, the engine will check with the `prevValue` variable and check if the `compare` condition is true.
````

## GitHub Actions vs locally

Pros/Cons using it as a GitHub Action:

- Pro: Can be ran all the day with no machine turned on.
- Con: Minimum 15 minutes intervals (GitHub Actions scheduler does not allow more).
- Con: Hard to setup on the fly.

Pros/Cons using it locally:

- Pro: Can check every minute.
- Pro: Easy to setup and modify on the fly.
- Pro: Can open webpage automatically (you are not dependent on Slack).
- Big con: Need a physical machine running all day.

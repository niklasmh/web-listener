# Thing to listen to

```yaml
interval: 60
delay: 0
initialValue: 0
compare: value !== prevValue
open: https://website.com/product
notify: "Website had a change in price from $" + prevValue + " to $" + value
user: niklasmh
debug: true
```

First we need to get some data:

```fetch
html:https://website.com/product
method:GET
header:accept:text/html
header:user-agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36
```

Now we need to extract the data which now exists in the `html` variable as a DOM-object:

```javascript
const price = html.querySelector("#price").innerHTML.replace(/[^\d]/g, "");
return parseInt(price);
```

It is possible to continue the pipeline using the `value` as a reference.

In the end, the `value` will be stored into `prevValue` in the next run.

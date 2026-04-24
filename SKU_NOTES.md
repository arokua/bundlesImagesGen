# Bundle Gen — Per-SKU Notes

These notes are injected into the image prompt whenever a bundle contains the matching SKU, so the model knows exactly what that SKU *is* (and what it isn't).

Format: one section per SKU, starting with `## <SKU>`, followed by free-form text. Keep it short and concrete. Example:

<!--

## 231
This product is horizontal hanger, meaning the stick that the "donut discs" hange on is parrarel with the ground, it is connected to the toy base via a rectangle wooden piece. The base is squared in shape (10 cm squared) product dimensions is 10 × 10 × 8.5 cm
-->

## 416
product is the whole alphabet set, you may include the box, but do not create an image with just the letters

## 878
Main product = the wooden coin sorting box with sliding lid. The stacking rings visible in some references are unrelated accessories — do not treat them as the primary item for SKU 878.

# PicToWebP 🖼️➡️🌐

Welcome to **PicToWebP**! 🎉

Have you ever been so overwhelmed by the sheer size of your image collections that you thought, "If only these could magically weigh less without sacrificing the quality!"? Well, put on your wizard hat, because we're about to do some magic.✨

## Why Should You Care? 🤔

Images are like cats on the internet: everywhere. But unlike cats, heavy images can slow down your site, eat up your storage, and make your users wait. Nobody likes waiting, especially your cat. 🐱

**PicToWebP** takes your chunky images and turns them into lightweight WebP beauties, without compromising on the quality. Here are some solid reasons to get excited:

1. **Smaller Size, Same Quality**: WebP format is proven to have a smaller file size for the same quality when compared to formats like JPEG or PNG.
2. **Faster Websites**: Smaller image sizes mean faster load times. Give your users a zippy experience!
3. **Save on Storage Costs**: When you're running a site with thousands of images or have a huge image library on the cloud (like on Google Drive), converting them to WebP can save you a lot of space, and as we all know, space costs money. 💰
4. **Environmentally Friendly**: Smaller files = Less server power = A happier Earth. 🌍❤️

## Features 🚀

- Convert entire folders of images in a jiffy.
- Multithreaded conversion: Like having several baristas making your coffee at once.
- Detailed reporting: See how many megabytes you've saved, feel good about yourself.
- It's as simple as running a script. No overcomplicated UI or steps.

## Quick Start 🏁

1. Clone the repository.
2. Navigate to the directory.
3. Install the required dependencies via pip- pillow, tqdm
4. Run the script.
5. Provide the folder path with images you want to convert.
6. Provide the details for image quality and threads to process (press enter directly to use default values).
7. Sit back and watch the magic happen! (You can wear your wizard hat now.)

```bash
git clone https://github.com/aditya-xq/PicToWebP.git
cd PicToWebP/src
python convert.py
```
The script creates a new sub-folder in the source folder with all the images converted to the chosen format. In some cases, it can reduce memory usage by over 90% without any noticeable change in the quality of the images!

If you'd like a sleek user interface instead of command line, run the flask app in src folder. Visit localhost:5000 to access the UI.
```bash
python app.py
```

Are you a rusteacean? Check out the rust version at src_rust folder. Use the below command to run it.
```bash
cd src_rust
cargo run --release
```

## Final Words 🎤

If you're tired of your images taking up more space than they should, give **PicToWebP** a try. It's like putting your images on a fun diet, where they lose weight but none of the charm!

Also, if you've ever wondered if magic exists in the world of images, well, here's your proof. 😉 Join us in making the internet a lighter place!

---

P.S. No cats were harmed in the making of this script. They were too busy ruling the internet. 🐈‍⬛

P.P.S. Feedback is love. If you've got suggestions or a funny cat GIF, do drop by our Issues section! 💌
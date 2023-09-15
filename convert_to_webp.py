import os
from PIL import Image
from time import time
import shutil
import logging
from concurrent.futures import ThreadPoolExecutor

# Setup a logger to capture logs and stream it to the console.
def setup_logger():
    logging.basicConfig(filename='image_conversion.log', level=logging.INFO, 
                        format='%(asctime)s - %(levelname)s - %(message)s')
    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    logging.getLogger('').addHandler(console)

# Fetch all image files from the specified source folder.
def get_image_files(source_folder):
    return [
        os.path.join(root, file_name)
        for root, dirs, files in os.walk(source_folder)
        for file_name in files
        if file_name.endswith(("png", "jpeg", "jpg"))
    ]

# Create the output folder where converted files will be stored.
# If the folder already exists, it moves it to a backup folder to avoid data loss.
def create_output_folder(source_folder):
    output_folder = f"{source_folder}_webp"
    if os.path.exists(output_folder):
        backup_folder = f"{source_folder}_webp_backup_{int(time())}"
        shutil.move(output_folder, backup_folder)
        logging.warning(f"Output folder already existed. Moved to {backup_folder}.")
    os.makedirs(output_folder)
    return output_folder

# Process a single file - convert it to WEBP format and store file sizes for reporting.
def process_file(file_path, output_folder, quality, stats):
    output_file_path = os.path.join(output_folder, os.path.relpath(file_path, source_folder))
    output_file_dir = os.path.dirname(output_file_path)
    os.makedirs(output_file_dir, exist_ok=True)
    output_file_path = os.path.splitext(output_file_path)[0] + '.webp'

    original_size = os.path.getsize(file_path)
    stats['total_original_size'] += original_size

    try:
        with Image.open(file_path) as img:
            img.convert("RGB").save(output_file_path, "WEBP", quality=quality)

        converted_size = os.path.getsize(output_file_path)
        stats['total_converted_size'] += converted_size
        stats['conversion_count'] += 1
    except Exception as e:
        logging.error(f"Failed to convert {file_path}: {e}")

# Generate a final report with the memory saved, conversion count, and time taken.
def generate_report(stats):
    memory_reduced = (stats['total_original_size'] - stats['total_converted_size']) / (1024 * 1024)  # in megabytes
    reduction_percentage = (memory_reduced / (stats['total_original_size'] / (1024 * 1024))) * 100

    logging.info(f"\nTotal memory reduced: {memory_reduced:.2f} MB ({reduction_percentage:.2f}%)")
    logging.info(f"Total number of images converted: {stats['conversion_count']}")
    logging.info(f"Total time taken: {stats['total_time']:.2f} seconds")

# Main function to convert images in the given folder to WEBP format.
def convert_images_to_webp(source_folder, quality=80, threads=4):
    if not os.path.isdir(source_folder):
        logging.error(f"The folder {source_folder} does not exist.")
        return

    start_time = time()

    # Initialize stats dictionary to keep track of conversion statistics.
    stats = {
        'total_original_size': 0,
        'total_converted_size': 0,
        'conversion_count': 0,
        'total_time': 0
    }

    file_list = get_image_files(source_folder)
    output_folder = create_output_folder(source_folder)

    # Use ThreadPoolExecutor to perform conversions in parallel, improving performance.
    with ThreadPoolExecutor(max_workers=threads) as executor:
        list(executor.map(lambda file_path: process_file(file_path, output_folder, quality, stats), file_list))

    stats['total_time'] = time() - start_time
    generate_report(stats)

# Entry point of the script.
if __name__ == "__main__":
    setup_logger()
    source_folder = input("Enter the path to the source folder: ")
    convert_images_to_webp(source_folder)
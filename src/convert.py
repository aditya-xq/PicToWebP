import logging
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from tqdm import tqdm
from time import time
from pathlib import Path
from enum import Enum
from constants import DEFAULT_QUALITY, DEFAULT_THREADS
from enums import OutputImageFormat
from logging_config import setup_logging
from utils import (
    get_user_input,
    process_file,
    get_image_files,
    create_output_folder,
    generate_report,
    OperationCancelledError
)

# Create a logger for this module
logger = logging.getLogger(__name__)

def worker(file_path: Path, source_folder: Path, output_folder: Path, quality: int, format: Enum):
    """
    Process a single file and log any errors.
    :param file_path: Path of the file to be processed.
    :param source_folder: Source folder path.
    :param output_folder: Output folder path.
    :param quality: Quality for the conversion.
    :param format: Format to convert the image to.
    """
    try:
        return process_file(file_path, source_folder, output_folder, quality, format.value)
    except OperationCancelledError as e:
        logger.error(f"Operation cancelled while processing {file_path}: {e}")
    except Exception as e:
        logger.error(f"Error processing {file_path}: {e}")

def update_conversion_stats(stats, original_size, converted_size, files_converted):
    """
    Update conversion stats after processing each file.
    :param stats: Conversion stats dictionary.
    :param original_size: Original size of the processed file.
    :param converted_size: Converted size of the processed file.
    :param files_converted: Number of files successfully converted.
    """
    stats['total_original_size'] += original_size
    stats['total_converted_size'] += converted_size
    stats['conversion_count'] += files_converted
    return stats

def get_user_settings():
    """
    Get user settings like source folder, quality and number of threads.
    :return: Tuple containing source folder, quality and number of threads.
    """
    source_folder = get_user_input(
        "Enter the path to the source folder: ",
        Path.is_dir,
        Path,
        "Invalid directory path. Please enter a valid path."
    )

    quality = get_user_input(
        f"Enter the quality (default {DEFAULT_QUALITY}): ",
        lambda x: isinstance(x, int) and x > 0,
        int,
        "Invalid input. Please enter a valid number.",
        DEFAULT_QUALITY
    )

    threads = get_user_input(
        f"Enter the number of threads (default {DEFAULT_THREADS}): ",
        lambda x: isinstance(x, int) and x > 0,
        int,
        "Invalid input. Please enter a valid number.",
        DEFAULT_THREADS
    )

    return source_folder, quality, threads

def convert_images(source_folder_path: Path, quality: int = DEFAULT_QUALITY, threads: int = DEFAULT_THREADS,
                   format: Enum = OutputImageFormat.WEBP):
    """
    Convert images in the source folder to the specified format.
    :param source_folder_path: Source folder path containing the images.
    :param quality: Quality for the conversion.
    :param threads: Number of threads to be used for the conversion.
    :param format: Format to convert the images to.
    """
    conversion_stats = {'total_original_size': 0, 'total_converted_size': 0, 'conversion_count': 0}

    file_list = get_image_files(source_folder_path)
    if not file_list:
        logger.info("No image files found in the source folder.")
        return

    try:
        output_folder = create_output_folder(source_folder_path, format.value)
    except OperationCancelledError as e:
        logger.error(str(e))
        return
    
    logger.info("*** Starting a new conversion process... ***")

    start_time = time()

    with ThreadPoolExecutor(max_workers=threads) as executor:
        worker_partial = partial(worker, source_folder=source_folder_path, output_folder=output_folder, quality=quality,
                                 format=format)
        for original_size, converted_size, files_converted in tqdm(executor.map(worker_partial, file_list),
                                                                   total=len(file_list), unit="file"):
            conversion_stats = update_conversion_stats(conversion_stats, original_size, converted_size, files_converted)

    conversion_stats['total_time'] = time() - start_time
    generate_report(conversion_stats)

def main():
    """
    Main function to execute the script.
    """
    setup_logging()
    source_folder, quality, threads = get_user_settings()
    image_format = OutputImageFormat.WEBP
    convert_images(source_folder, quality, threads, image_format)

if __name__ == "__main__":
    main()
import logging
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import List
from tqdm import tqdm
from time import time
from pathlib import Path
from enum import Enum
from constants import DEFAULT_QUALITY, DEFAULT_THREADS
from enums import OutputImageFormat
from logging_config import setup_logging
from utils import (
    get_user_settings,
    print_separator,
    process_file,
    get_image_files,
    create_output_folder,
    generate_report,
    OperationCancelledError
)

# Create a logger for this module
logger = logging.getLogger(__name__)

def worker(batch_of_files: List[Path], source_folder: Path, output_folder: Path, quality: int, format: Enum):
    """
    Process a batch of files and log any errors.
    :param batch_of_files: List of Paths of the files to be processed.
    :param source_folder: Source folder path.
    :param output_folder: Output folder path.
    :param quality: Quality for the conversion.
    :param format: Format to convert the image to.
    """
    batch_stats = {'total_original_size': 0, 'total_converted_size': 0, 'conversion_count': 0}
    for file_path in batch_of_files:
        try:
            original_size, converted_size, files_converted = process_file(file_path, source_folder, output_folder, quality, format.value)
            batch_stats = update_conversion_stats(batch_stats, original_size, converted_size, files_converted)
        except OperationCancelledError as e:
            logger.error(f"Operation cancelled while processing {file_path}: {e}")
        except Exception as e:
            logger.error(f"Error processing {file_path}: {e}")
    return batch_stats

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

global_conversion_progress = {}

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
    global global_conversion_progress

    file_list = get_image_files(source_folder_path)
    global_conversion_progress['num_files'] = len(file_list)

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

    # Create batches of file paths
    batch_size = len(file_list) // (threads * 32)
    batches_of_files = [file_list[i:i + batch_size] for i in range(0, len(file_list), batch_size)]

    with ThreadPoolExecutor(max_workers=threads) as executor:
        worker_partial = partial(worker, source_folder=source_folder_path, output_folder=output_folder, quality=quality,
                                 format=format)
        for batch_stats in tqdm(executor.map(worker_partial, batches_of_files), total=len(batches_of_files), unit="batch"):
            conversion_stats = update_conversion_stats(conversion_stats, batch_stats['total_original_size'], batch_stats['total_converted_size'], batch_stats['conversion_count'])
            global_conversion_progress['stats'] = conversion_stats
    conversion_stats['total_time'] = time() - start_time
    generate_report(conversion_stats)

def main():
    """
    Main function to execute the script.
    """
    print_separator()
    setup_logging()
    source_folder, quality, threads = get_user_settings()
    image_format = OutputImageFormat.WEBP
    convert_images(source_folder, quality, threads, image_format)

if __name__ == "__main__":
    main()
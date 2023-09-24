import logging
from pathlib import Path
import shutil
from typing import List, Tuple, TypedDict, Callable, Optional, Any

from PIL import Image, UnidentifiedImageError

from enums import ImageFormat
from exceptions import OperationCancelledError

# Create a logger for this module
logger = logging.getLogger(__name__)

class Stats(TypedDict):
    """TypedDict representing the structure for conversion statistics."""
    total_original_size: int
    total_converted_size: int
    conversion_count: int
    total_time: float

def get_user_input_for_folder(prompt: str, allowed_responses: set[str], max_retries: int = 3) -> str:
    """
    Get user input and validate it against allowed responses.
    Retries for max_retries times before raising a ValueError.
    
    :param prompt: The prompt message to be displayed to the user.
    :param allowed_responses: A set of allowed responses.
    :param max_retries: Maximum number of retries before raising an error.
    :return: The valid user input.
    :raises ValueError: If the maximum retries are reached with invalid input.
    """
    for _ in range(max_retries):
        user_input = input(prompt).lower()
        if user_input in allowed_responses:
            return user_input
        logger.warning(f"Invalid input. Allowed responses are: {', '.join(allowed_responses)}.")
    raise ValueError("Maximum retries reached. Invalid input.")

def validate_input(user_input: str, validation_func: Callable[[Any], bool], conversion_func: Callable[[str], Any], 
                   error_message: str, default: Optional[Any] = None) -> Optional[Any]:
    """
    Validate and convert user input using the provided validation and conversion functions.
    
    :param user_input: User input to be validated and converted.
    :param validation_func: Function to validate user input.
    :param conversion_func: Function to convert user input to the desired type.
    :param error_message: Message to be displayed when validation fails.
    :param default: Default value to be returned if the user does not provide input.
    :return: Validated and converted user input.
    """
    if user_input:
        try:
            converted_input = conversion_func(user_input)
            if validation_func(converted_input):
                return converted_input
            else:
                logger.warning(error_message)
        except ValueError:
            logger.warning(error_message)
    elif default is not None:
        return default
    else:
        logger.warning(error_message)
    return None

def get_user_input(prompt: str, validation_func: Callable[[Any], bool], conversion_func: Callable[[str], Any], 
                   error_message: str, default: Optional[Any] = None) -> Any:
    """
    Get user input, convert it, and validate it using the provided validation and conversion functions.
    
    :param prompt: Prompt message to be displayed to the user.
    :param validation_func: Function to validate user input.
    :param conversion_func: Function to convert user input to the desired type.
    :param error_message: Message to be displayed when validation fails.
    :param default: Default value to be returned if the user does not provide input.
    :return: Validated and converted user input.
    """
    while True:
        user_input = input(prompt)
        valid_input = validate_input(user_input, validation_func, conversion_func, error_message, default)
        if valid_input is not None:
            return valid_input
        else:
            logger.error(error_message)  # Inform the user immediately

def get_image_files(source_folder: Path) -> List[Path]:
    """
    Given a source folder, returns a list of all image files in the folder
    and its subfolders based on valid image suffixes.
    
    :param source_folder: The source folder path.
    :return: A list of image file paths.
    """
    image_files = []
    patterns = [f"*.{img_format.value.lower()}" for img_format in ImageFormat]
    for pattern in patterns:
        image_files.extend(source_folder.rglob(pattern))
    return image_files

def create_output_folder(source_folder: Path, format: str) -> Path:
    """
    Create an output folder for the converted images.
    If the output folder already exists, the user is prompted whether to replace it.
    
    :param source_folder: The source folder path.
    :param format: The image format for conversion.
    :return: The output folder path.
    :raises OperationCancelledError: If the operation is cancelled by the user.
    """
    output_folder = source_folder.parent / f"{source_folder.name}_{format.lower()}"
    if output_folder.is_dir():
        user_input = get_user_input_for_folder("Output folder already exists. Do you want to replace it? (y/n): ", {'y', 'n'})
        if user_input == 'n':
            raise OperationCancelledError("Operation cancelled by the user.")
        shutil.rmtree(output_folder)
    output_folder.mkdir(parents=True, exist_ok=True)
    return output_folder

def process_file(file_path: Path, source_folder: Path, output_folder: Path, quality: int, format: str) -> Tuple[int, int, int]:
    """
    Process each image file, convert it to the desired format and quality, 
    and save it to the output folder.
    
    :param file_path: The path of the file to be processed.
    :param source_folder: The source folder path.
    :param output_folder: The output folder path.
    :param quality: The quality of the converted image.
    :param format: The format of the converted image.
    :return: A tuple containing the original size, converted size, and count (1).
    """
    output_file_path = output_folder / file_path.relative_to(source_folder).with_suffix(f".{format.lower()}")
    output_file_path.parent.mkdir(parents=True, exist_ok=True)
    original_size = file_path.stat().st_size

    try:
        with Image.open(file_path) as img:
            img.convert("RGB").save(output_file_path, format, quality=quality)  # Convert to RGB as some formats don't support RGBA
    except (UnidentifiedImageError, PermissionError, FileNotFoundError) as error:
        logger.error(f"Error processing file {file_path}. Error: {error}")
        return (0, 0, 0)

    converted_size = output_file_path.stat().st_size
    return (original_size, converted_size, 1)

def generate_report(stats: Stats):
    """
    Generate a report of the conversion, logging the total memory reduced, 
    total number of images converted, and total time taken.
    
    :param stats: The conversion statistics.
    """
    memory_reduced = (stats['total_original_size'] - stats['total_converted_size']) / (1024 * 1024)
    reduction_percentage = ((stats['total_original_size'] - stats['total_converted_size']) / stats['total_original_size']) * 100
    
    logger.info(f"Total memory reduced: {memory_reduced:.2f} MB ({reduction_percentage:.2f}%)")
    logger.info(f"Total number of images converted: {stats['conversion_count']}")
    logger.info(f"Total time taken: {stats['total_time']:.2f} seconds")
